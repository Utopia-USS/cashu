"""Shared helpers for the market data tests. No live HTTP: every client runs on httpx.MockTransport."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx

from cashu.modules.investments.domain import (
    AssetClass,
    Currency,
    Instrument,
    InstrumentAlias,
)
from cashu.modules.investments.market import MarketHttp

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "market"
FETCHED_AT = datetime(2026, 10, 4, 18, tzinfo=UTC)
"""Fetch time the sources stamp on bars and rates in tests."""


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def d(value: str | int) -> Decimal:
    return Decimal(str(value))


def day(iso: str) -> date:
    return date.fromisoformat(iso)


def fake_clock() -> datetime:
    return FETCHED_AT


class FakeTime:
    """Fake monotonic time for MarketHttp: ``sleep`` records the delay and advances ``now`` instantly."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


Handler = Callable[[httpx.Request], httpx.Response]


def respond(body: str, status: int = 200, content_type: str = "application/json; charset=utf-8"):
    return httpx.Response(status, text=body, headers={"content-type": content_type})


def recording(requests: list[httpx.Request], handler: Handler) -> httpx.Client:
    """A client whose transport records requests into ``requests`` and answers with ``handler``."""

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    return httpx.Client(transport=httpx.MockTransport(handle))


def make_http(
    client: httpx.Client, time: FakeTime | None = None, timeout: float = 15.0
) -> MarketHttp:
    """A MarketHttp over ``client`` with fake time (no real waiting)."""
    clock = time or FakeTime()
    return MarketHttp(client, timeout=timeout, sleep=clock.sleep, clock=clock)


def build_instrument(
    *,
    name: str = "Orlen",
    symbol: str | None = "PKN",
    mic: str | None = "XWAR",
    currency: Currency = Currency.PLN,
    asset_class: AssetClass = AssetClass.EQUITY,
    aliases: Iterable[InstrumentAlias] = (),
    **kwargs,
) -> Instrument:
    return Instrument(
        id=str(uuid4()),
        name=name,
        symbol=symbol,
        mic=mic,
        currency=currency,
        asset_class=asset_class,
        aliases=tuple(aliases),
        **kwargs,
    )


def orlen(aliases: Iterable[InstrumentAlias] | None = None) -> Instrument:
    """Orlen on GPW (XWAR) with confirmed stooq and yahoo aliases."""
    if aliases is None:
        aliases = (InstrumentAlias("stooq", "pkn"), InstrumentAlias("yahoo", "PKN.WA"))
    return build_instrument(aliases=aliases)


def vwce(aliases: Iterable[InstrumentAlias] | None = None) -> Instrument:
    """Vanguard FTSE All-World on XETRA with confirmed yahoo and stooq aliases."""
    if aliases is None:
        aliases = (InstrumentAlias("yahoo", "VWCE.DE"), InstrumentAlias("stooq", "vwce.de"))
    return build_instrument(
        name="Vanguard FTSE All-World",
        symbol="VWCE",
        mic="XETR",
        currency=Currency.EUR,
        asset_class=AssetClass.ETF,
        aliases=aliases,
    )


def utc(y: int, m: int, dd: int, h: int = 0, minute: int = 0) -> int:
    """Epoch seconds of a UTC wall time."""
    return int(datetime(y, m, dd, h, minute, tzinfo=UTC).timestamp())


def weekdays(start: date, end: date) -> list[date]:
    days, current = [], start
    while current <= end:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


def yahoo_chart(
    start: date,
    end: date,
    close: Callable[[date], str],
    *,
    currency: str = "USD",
    splits: Iterable[tuple[date, int, int]] = (),
) -> str:
    """A chart response in Yahoo's recorded format (NASDAQ: sessions open 13:30 UTC, gmtoffset -4 h)
    with one session per weekday of ``start..end`` and the given splits inside the range."""

    def stamp(on: date) -> int:
        return utc(on.year, on.month, on.day, 13, 30)

    dates = weekdays(start, end)
    closes = [float(close(on)) for on in dates]
    return json.dumps(
        {
            "chart": {
                "result": [
                    {
                        "meta": {
                            "currency": currency,
                            "symbol": "TEST",
                            "exchangeName": "NMS",
                            "gmtoffset": -14400,
                            "priceHint": 2,
                        },
                        "timestamp": [stamp(on) for on in dates],
                        "events": {
                            "splits": {
                                str(stamp(on)): {
                                    "date": stamp(on),
                                    "numerator": numerator,
                                    "denominator": denominator,
                                    "splitRatio": f"{numerator}:{denominator}",
                                }
                                for on, numerator, denominator in splits
                                if start <= on <= end
                            }
                        },
                        "indicators": {
                            "quote": [
                                {
                                    "open": closes,
                                    "high": closes,
                                    "low": closes,
                                    "close": closes,
                                    "volume": [1000 for _ in dates],
                                }
                            ]
                        },
                    }
                ],
                "error": None,
            }
        }
    )


def yahoo_chart_client(
    requests: list[httpx.Request],
    close: Callable[[date], str],
    *,
    currency: str = "USD",
    splits: Iterable[tuple[date, int, int]] = (),
) -> httpx.Client:
    """Answers every chart request with :func:`yahoo_chart` for the requested period1..period2."""
    split_list = list(splits)

    def handler(request: httpx.Request) -> httpx.Response:
        def date_of(key: str) -> date:
            return datetime.fromtimestamp(int(request.url.params[key]), UTC).date()

        body = yahoo_chart(
            date_of("period1"), date_of("period2"), close, currency=currency, splits=split_list
        )
        return respond(body)

    return recording(requests, handler)
