"""Daily bars from Yahoo's unofficial chart endpoint (no key)."""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from ..domain import (
    AliasNamespace,
    CalendarDate,
    Currency,
    Instrument,
    PriceBar,
    divided_by,
)
from .market_http import MarketHttp, body_snippet
from .sources import (
    NoPriceSourceException,
    PriceHistory,
    PriceSource,
    QuoteCurrencyMismatchException,
    SourceBlockedException,
    SourceException,
    SplitEvent,
)

UtcClock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


_MINOR_UNITS = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}
"""Minor-unit quote currencies Yahoo uses and their major currency (prices / 100)."""


class YahooPriceSource(PriceSource):
    """Daily bars from ``https://query1.finance.yahoo.com/v8/finance/chart/<alias>``.

    Symbol: the instrument's ``yahoo`` alias (``VWCE.DE``, ``PKN.WA``, ``AAPL``).

    Dates: a bar's timestamp (session open or local midnight, UTC seconds) is shifted by the exchange's
    ``meta.gmtoffset`` to get the exchange calendar date. ``gmtoffset`` is the offset in force at fetch
    time, so a bar from the other side of a DST switch can be off by one hour; a shifted time of 22:00 or
    later can only be a local-midnight stamp read with the wrong offset and counts as the next day.

    Prices: Yahoo serves single-precision floats widened to doubles (166.22 arrives as
    166.22000122070312). A value that is exactly a float32 becomes the shortest decimal that maps to the
    same float32 (166.22); any other value keeps its shortest double form.

    Currency (R3): ``meta.currency`` is the quote currency. Minor units are normalized (``GBp`` / ``GBX``
    -> GBP, ``ZAc`` -> ZAR, ``ILA`` -> ILS, every price divided by 100). When the normalized currency
    differs from ``Instrument.currency`` a non-retryable :class:`QuoteCurrencyMismatchException` is raised
    and no bar is returned. Bars carry the quote currency.

    Splits (R6): the request asks for ``events=split``; splits within the range come back in
    :attr:`PriceHistory.splits`. Yahoo's ``close`` is split-adjusted retroactively, so stored bars from
    before a split must be fetched again (see ``refresh``).

    Errors: an unknown symbol (``chart.error``, usually HTTP 404) is a non-retryable
    :class:`SourceException`; HTTP 401/403 is a :class:`SourceBlockedException`; a range without sessions
    is an empty answer.
    """

    DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    """Short browser-like agent (a full but outdated browser string got HTTP 429 in live tries)."""

    def __init__(
        self,
        http: MarketHttp,
        *,
        host: str = "query1.finance.yahoo.com",
        user_agent: str = DEFAULT_USER_AGENT,
        clock: UtcClock = utc_now,
    ) -> None:
        self._http = http
        self.host = host
        self.user_agent = user_agent
        self._clock = clock

    @property
    def id(self) -> str:
        return AliasNamespace.YAHOO

    def history(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> list[PriceBar]:
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: CalendarDate, end: CalendarDate) -> PriceHistory:
        symbol = instrument.alias(AliasNamespace.YAHOO)
        if symbol is None:
            raise NoPriceSourceException(self.id, f"instrument {instrument.id} has no yahoo alias")
        if start > end:
            return PriceHistory()
        # One extra day on each side covers every UTC offset; parsing filters by exchange date.
        response = self._http.get(
            f"https://{self.host}/v8/finance/chart/{symbol}",
            source_id=self.id,
            params={
                "period1": str(_epoch(start - timedelta(days=1))),
                "period2": str(_epoch(end + timedelta(days=2))),
                "interval": "1d",
                "events": "split",
            },
            headers={"User-Agent": self.user_agent, "Accept": "application/json"},
        )
        status = response.status_code
        if status in (401, 403):
            raise SourceBlockedException(
                self.id, f'HTTP {status} for "{symbol}": {body_snippet(response.text)}'
            )
        if status not in (200, 404):
            raise SourceException(
                self.id, f'HTTP {status} for "{symbol}": {body_snippet(response.text)}'
            )
        return self.parse_history(response.text, instrument, start, end, symbol=symbol)

    def parse(
        self,
        body: str,
        instrument: Instrument,
        start: CalendarDate,
        end: CalendarDate,
        *,
        symbol: str | None = None,
    ) -> list[PriceBar]:
        """The bars of :meth:`parse_history`."""
        return list(self.parse_history(body, instrument, start, end, symbol=symbol).bars)

    def parse_history(
        self,
        body: str,
        instrument: Instrument,
        start: CalendarDate,
        end: CalendarDate,
        *,
        symbol: str | None = None,
    ) -> PriceHistory:
        """Parses a chart response body into bars dated within ``start..end`` (exchange dates), oldest
        first, plus the splits in that range and the quote currency. Rows without a close are skipped;
        a repeated date keeps the later row."""
        what = "" if symbol is None else f' for "{symbol}"'

        def unexpected(detail: str, cause: BaseException | None = None) -> SourceException:
            return SourceException(self.id, f"unexpected response{what}: {detail}", cause=cause)

        try:
            data = json.loads(body)
        except ValueError as error:
            raise unexpected(body_snippet(body), error) from error
        if not isinstance(data, dict) or not isinstance(data.get("chart"), dict):
            raise unexpected(body_snippet(body))
        chart = data["chart"]
        error = chart.get("error")
        if isinstance(error, dict):
            raise SourceException(
                self.id,
                f"no such symbol{what} ({error.get('code')}: {error.get('description')})",
            )
        results = chart.get("result")
        if not isinstance(results, list) or not results or not isinstance(results[0], dict):
            raise unexpected("no chart result")
        result = results[0]
        meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
        offset = meta.get("gmtoffset")
        offset = int(offset) if _is_number(offset) else 0
        currency, divisor = self._quote_currency(meta.get("currency"), what)
        if currency is not None and currency != instrument.currency:
            raise QuoteCurrencyMismatchException(
                self.id,
                f"quote currency {currency}{what} differs from the instrument currency "
                f"{instrument.currency}; no bars stored (fix the instrument currency or its yahoo "
                "alias)",
                quote_currency=currency,
                instrument_currency=instrument.currency,
            )
        splits = _splits(result.get("events"), offset, start, end)
        timestamps = result.get("timestamp")
        if timestamps is None:  # a range without sessions has no timestamp list
            return PriceHistory(splits=splits, currency=currency)
        indicators = result.get("indicators")
        quotes = indicators.get("quote") if isinstance(indicators, dict) else None
        if (
            isinstance(timestamps, list)
            and isinstance(quotes, list)
            and quotes
            and isinstance(quotes[0], dict)
        ):
            bars = self._bars(
                instrument, start, end, offset, timestamps, quotes[0], currency, divisor
            )
            return PriceHistory(bars=bars, splits=splits, currency=currency)
        raise unexpected("no timestamp / quote arrays")

    def _quote_currency(self, raw: object, what: str) -> tuple[Currency | None, int]:
        """The normalized quote currency and the price divisor (1 or 100); (None, 1) when absent."""
        if not isinstance(raw, str) or not raw.strip():
            return None, 1
        code = raw.strip()
        major = _MINOR_UNITS.get(code)
        if major is not None:
            return Currency(major), 100
        # Checked before Currency() normalizes: Currency("GBp") would silently become GBP.
        try:
            return Currency(code), 1
        except ValueError:
            raise SourceException(
                self.id, f'unexpected response{what}: quote currency "{code}"'
            ) from None

    def _bars(
        self,
        instrument: Instrument,
        start: CalendarDate,
        end: CalendarDate,
        offset: int,
        timestamps: Sequence[Any],
        quote: Mapping[str, Any],
        currency: Currency | None,
        divisor: int,
    ) -> tuple[PriceBar, ...]:
        def series(key: str) -> Sequence[Any]:
            values = quote.get(key)
            return values if isinstance(values, list) else []

        def at(values: Sequence[Any], index: int) -> Any:
            return values[index] if index < len(values) else None

        def scaled(price: Decimal | None) -> Decimal | None:
            return price if price is None or divisor == 1 else price.scaleb(-2)

        opens, highs, lows = series("open"), series("high"), series("low")
        closes, volumes = series("close"), series("volume")
        fetched_at = self._clock()
        bars: dict[CalendarDate, PriceBar] = {}
        for index, timestamp in enumerate(timestamps):
            close = scaled(_price(at(closes, index)))
            if not _is_number(timestamp) or close is None:
                continue
            on = exchange_date(int(timestamp), offset)
            if on < start or on > end:
                continue
            volume = at(volumes, index)
            bars[on] = PriceBar(
                instrument_id=instrument.id,
                date=on,
                open=scaled(_price(at(opens, index))),
                high=scaled(_price(at(highs, index))),
                low=scaled(_price(at(lows, index))),
                close=close,
                volume=round(volume) if _is_number(volume) else None,
                source=self.id,
                fetched_at=fetched_at,
                currency=currency,
            )
        return tuple(bars[on] for on in sorted(bars))


def exchange_date(epoch_seconds: int, gmt_offset_seconds: int) -> CalendarDate:
    """Exchange calendar date of a bar stamped ``epoch_seconds`` (UTC) on an exchange
    ``gmt_offset_seconds`` from UTC, with the 22:00 rule (see :class:`YahooPriceSource`)."""
    local = datetime.fromtimestamp(epoch_seconds + gmt_offset_seconds, UTC)
    on = local.date()
    return on + timedelta(days=1) if local.hour >= 22 else on


def _epoch(on: CalendarDate) -> int:
    return int(datetime(on.year, on.month, on.day, tzinfo=UTC).timestamp())


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _float32(value: float) -> float:
    return struct.unpack("f", struct.pack("f", value))[0]


def _price(value: object) -> Decimal | None:
    """A Yahoo price without float32 noise (see :class:`YahooPriceSource`), or None."""
    if not _is_number(value):
        return None
    v = float(value)  # type: ignore[arg-type]
    if not math.isfinite(v):
        return None
    try:
        is_float32 = _float32(v) == v
    except OverflowError:
        is_float32 = False
    if is_float32:
        for precision in range(1, 10):
            candidate = f"{v:.{precision}g}"
            if _float32(float(candidate)) == v:
                return _plain(Decimal(candidate))
    return _plain(Decimal(repr(v)))


def _plain(value: Decimal) -> Decimal:
    """``1E+2`` -> ``100`` (positive exponents only; the value is unchanged)."""
    return value.quantize(Decimal(1)) if value.as_tuple().exponent > 0 else value  # type: ignore[operator]


def _splits(
    events: object, offset: int, start: CalendarDate, end: CalendarDate
) -> tuple[SplitEvent, ...]:
    """Splits in ``events.splits`` dated within ``start..end`` (exchange dates), oldest first."""
    if not isinstance(events, dict) or not isinstance(events.get("splits"), dict):
        return ()
    result: list[SplitEvent] = []
    for entry in events["splits"].values():
        if not isinstance(entry, dict):
            continue
        stamp, numerator, denominator = (
            entry.get("date"),
            entry.get("numerator"),
            entry.get("denominator"),
        )
        if not (_is_number(stamp) and _is_number(numerator) and _is_number(denominator)):
            continue
        if numerator <= 0 or denominator <= 0:
            continue
        on = exchange_date(int(stamp), offset)
        if on < start or on > end:
            continue
        ratio = divided_by(Decimal(repr(numerator)), Decimal(repr(denominator))).normalize()
        result.append(SplitEvent(date=on, ratio=_plain(ratio)))
    return tuple(sorted(result, key=lambda split: split.date))
