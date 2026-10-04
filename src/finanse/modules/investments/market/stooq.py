"""Daily bars from stooq's CSV download. Blocked by a bot check since 2026-10 (detected, never bypassed)."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation

from ..domain import AliasNamespace, CalendarDate, Instrument, PriceBar
from .market_http import MarketHttp, body_snippet
from .sources import NoPriceSourceException, PriceSource, SourceBlockedException, SourceException
from .yahoo import UtcClock, utc_now

_LINE_BREAK = re.compile(r"\r?\n")


class StooqPriceSource(PriceSource):
    """Daily bars from ``https://stooq.pl/q/d/l/?s=<alias>&i=d&d1=YYYYMMDD&d2=YYYYMMDD``.

    Symbol: the instrument's ``stooq`` alias (``pkn``, ``vwce.de``). Body handling:

    - CSV with Polish (``Data,Otwarcie,...,Zamkniecie,Wolumen``) or English (``Date,Open,...``) headers;
      the volume column is optional (indices, funds).
    - ``Brak danych`` / ``No data``: an empty list (stooq answers the same for an unknown symbol and for
      a range without sessions).
    - Bot-protection page, daily hit limit or API key demand: :class:`SourceBlockedException`. The
      composite then stops asking stooq for the rest of the run; nothing tries to pass the check.
    - Any other HTML or unexpected text, or a malformed row: a non-retryable :class:`SourceException`.

    Stooq reports no quote currency, so its bars carry ``currency = None`` (not checked; see the
    progress notes on guessed non-PLN stooq aliases).
    """

    def __init__(self, http: MarketHttp, *, host: str = "stooq.pl", clock: UtcClock = utc_now):
        self._http = http
        self.host = host
        """``stooq.pl`` (Polish headers) or ``stooq.com`` (English headers); both are parsed."""
        self._clock = clock

    @property
    def id(self) -> str:
        return AliasNamespace.STOOQ

    def history(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> list[PriceBar]:
        symbol = instrument.alias(AliasNamespace.STOOQ)
        if symbol is None:
            raise NoPriceSourceException(self.id, f"instrument {instrument.id} has no stooq alias")
        if start > end:
            return []
        response = self._http.get(
            f"https://{self.host}/q/d/l/",
            source_id=self.id,
            params={"s": symbol, "i": "d", "d1": _compact(start), "d2": _compact(end)},
        )
        if response.status_code != 200:
            raise SourceException(
                self.id,
                f'HTTP {response.status_code} for "{symbol}": {body_snippet(response.text)}',
            )
        return self.parse(response.text, instrument, start, end, symbol=symbol)

    def parse(
        self,
        body: str,
        instrument: Instrument,
        start: CalendarDate,
        end: CalendarDate,
        *,
        symbol: str | None = None,
    ) -> list[PriceBar]:
        """Parses a stooq CSV body into bars dated within ``start..end``, oldest first."""
        text = body.replace("﻿", "", 1).strip()
        lower = text.lower()
        what = "" if symbol is None else f' for "{symbol}"'
        if lower.startswith(("brak danych", "no data")):
            return []
        if not text:
            raise SourceException(self.id, f"empty response{what}", retryable=True)
        if "verify your browser" in lower or "/__verify" in lower or "captcha" in lower:
            raise SourceBlockedException(
                self.id, f"answered with a browser verification page{what}"
            )
        if "limit" in lower and ("przekroczony" in lower or "exceeded" in lower):
            raise SourceBlockedException(
                self.id, f"daily request limit exceeded{what}", retryable=True
            )
        if "apikey" in lower or "api key" in lower:
            raise SourceBlockedException(self.id, f"demands an API key{what}: {body_snippet(text)}")
        if lower.startswith("<") or "<html" in lower:
            raise SourceException(self.id, f"answered with an HTML page instead of CSV{what}")

        lines = [line for line in _LINE_BREAK.split(text) if line.strip()]
        header = [cell.strip().lower() for cell in lines[0].split(",")]

        def column(*names: str) -> int | None:
            return next((i for i, cell in enumerate(header) if cell in names), None)

        date_col, close_col = column("data", "date"), column("zamkniecie", "close")
        if date_col is None or close_col is None:
            raise SourceException(self.id, f"unexpected response{what}: {body_snippet(text)}")
        open_col, high_col = column("otwarcie", "open"), column("najwyzszy", "high")
        low_col, volume_col = column("najnizszy", "low"), column("wolumen", "volume")

        fetched_at = self._clock()
        bars: dict[CalendarDate, PriceBar] = {}
        for index, line in enumerate(lines[1:]):
            cells = line.split(",")

            def cell(col: int | None, cells: list[str] = cells) -> str | None:
                if col is None or col >= len(cells):
                    return None
                value = cells[col].strip()
                return value or None

            try:
                on = date.fromisoformat(cell(date_col) or "")
                if on < start or on > end:
                    continue
                volume = cell(volume_col)
                bars[on] = PriceBar(
                    instrument_id=instrument.id,
                    date=on,
                    open=_decimal(cell(open_col)),
                    high=_decimal(cell(high_col)),
                    low=_decimal(cell(low_col)),
                    close=_required_decimal(cell(close_col)),
                    volume=None if volume is None else _volume(volume),
                    source=self.id,
                    fetched_at=fetched_at,
                )
            except (ValueError, InvalidOperation) as error:
                raise SourceException(
                    self.id,
                    f"malformed CSV row {index + 2}{what}: {body_snippet(line)}",
                    cause=error,
                ) from error
        return [bars[on] for on in sorted(bars)]


def _decimal(value: str | None) -> Decimal | None:
    return None if value is None else _required_decimal(value)


def _required_decimal(value: str | None) -> Decimal:
    result = Decimal(value or "")
    if not result.is_finite():
        raise ValueError(f"not a finite number: {value!r}")
    return result


def _volume(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return round(float(value))


def _compact(on: CalendarDate) -> str:
    return on.isoformat().replace("-", "")
