"""NBP table A mid rates (official, free, no key): PLN per 1 unit of a currency."""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal

from ..domain import CalendarDate, Currency, FxRate
from .market_http import MarketHttp, body_snippet
from .sources import SourceException
from .yahoo import UtcClock, utc_now


class NbpFxSource:
    """Rates from ``https://api.nbp.pl/api/exchangerates/rates/A/<code>/<start>/<end>/?format=json``.

    A rate is PLN per 1 unit of the quote currency (``FxRate.base`` = PLN). Long ranges are split into
    requests of at most ``max_days_per_request`` days (inclusive). NBP answers HTTP 404 "Brak danych"
    for a range without any table (weekend, holiday, or a currency outside table A): that chunk simply
    contributes no rates. PLN itself has no rates (identity).
    """

    def __init__(
        self,
        http: MarketHttp,
        *,
        host: str = "api.nbp.pl",
        max_days_per_request: int = 93,
        clock: UtcClock = utc_now,
    ) -> None:
        if max_days_per_request <= 0:
            raise ValueError("max_days_per_request must be positive")
        self._http = http
        self.host = host
        self.max_days_per_request = max_days_per_request
        """Days per request, both ends inclusive. NBP documented 93; the live limit observed on
        2026-10-04 is 367 ("Limit of 367 days has been exceeded"). 93 works under both."""
        self._clock = clock

    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote: Currency, start: CalendarDate, end: CalendarDate) -> list[FxRate]:
        if quote == Currency.PLN or start > end:
            return []
        by_date: dict[CalendarDate, FxRate] = {}
        chunk_start = start
        while chunk_start <= end:
            chunk_end = min(chunk_start + timedelta(days=self.max_days_per_request - 1), end)
            for rate in self._chunk(quote, chunk_start, chunk_end):
                by_date[rate.date] = rate
            chunk_start += timedelta(days=self.max_days_per_request)
        return [by_date[on] for on in sorted(by_date)]

    def _chunk(self, quote: Currency, start: CalendarDate, end: CalendarDate) -> list[FxRate]:
        response = self._http.get(
            f"https://{self.host}/api/exchangerates/rates/A/{quote.lower()}/{start}/{end}/",
            source_id=self.id,
            params={"format": "json"},
            headers={"Accept": "application/json"},
        )
        if response.status_code == 404:
            return []
        if response.status_code != 200:
            raise SourceException(
                self.id,
                f"HTTP {response.status_code} for {quote} {start}..{end}: "
                f"{body_snippet(response.text)}",
            )
        return self.parse(response.text, quote, start, end)

    def parse(
        self, body: str, quote: Currency, start: CalendarDate, end: CalendarDate
    ) -> list[FxRate]:
        """Parses a table A rates response for ``quote`` into rates dated within ``start..end``."""

        def unexpected(detail: str, cause: BaseException | None = None) -> SourceException:
            return SourceException(
                self.id, f"unexpected response for {quote}: {detail}", cause=cause
            )

        try:
            data = json.loads(body, parse_float=Decimal)
        except ValueError as error:
            raise unexpected(body_snippet(body), error) from error
        if not isinstance(data, dict) or not isinstance(data.get("rates"), list):
            raise unexpected(body_snippet(body))
        code = data.get("code")
        if isinstance(code, str) and code.upper() != quote:
            raise unexpected(f"rates for {code}")
        fetched_at = self._clock()
        rates: list[FxRate] = []
        for entry in data["rates"]:
            effective = entry.get("effectiveDate") if isinstance(entry, dict) else None
            mid = entry.get("mid") if isinstance(entry, dict) else None
            if (
                not isinstance(effective, str)
                or not isinstance(mid, Decimal | int)
                or isinstance(mid, bool)
            ):
                raise unexpected(f"rate entry {body_snippet(str(entry))}")
            try:
                on = date.fromisoformat(effective)
            except ValueError as error:
                raise unexpected(f"rate entry {body_snippet(str(entry))}", error) from error
            if on < start or on > end:
                continue
            rates.append(
                FxRate(
                    quote=quote,
                    date=on,
                    rate=Decimal(mid),
                    source=self.id,
                    fetched_at=fetched_at,
                )
            )
        return sorted(rates, key=lambda rate: rate.date)
