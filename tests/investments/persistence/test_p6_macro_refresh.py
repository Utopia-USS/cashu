"""Macro series refresh (P6): the refresh plan (backfill window, incremental refetch, errors as entries),
the daily check's network phase (all series stored, USD/PLN history requested for the macro window,
offline and sources without a macro source skip it, a failing series never aborts the run or marks a
profile run partial, no transaction held while fetching) and the shared refresh glue. Fake sources
only (no live HTTP)."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from invp_support import (
    AS_OF,
    STRATEGY_YAML,
    FakeFx,
    FakePrices,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    weekdays,
)
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import utcnow
from cashu.modules.investments.domain import Currency, PriceBar
from cashu.modules.investments.macro import service as macro_service
from cashu.modules.investments.macro.refresh import (
    MAX_RETRIES,
    SKIPPED_MESSAGE,
    TIMEOUT_SECONDS,
    refresh_macro,
    window_start,
)
from cashu.modules.investments.macro.series import BACKFILL_DAYS, SERIES, SERIES_KEYS
from cashu.modules.investments.market import (
    ChartQuote,
    FetchStatus,
    SourceBlockedException,
    SourceException,
)
from cashu.modules.investments.models import InvMacroBar
from cashu.modules.investments.service import daily, files
from cashu.modules.investments.store import macro as macro_store

LEVELS = {
    "ACWI": "110.5",
    "^GSPC": "5600",
    "DX-Y.NYB": "101.2",
    "EEM": "44.1",
    "DBC": "22.3",
    "^TNX": "4.231",
    "^IRX": "3.9",
}


class FakeChart:
    """Yahoo chart stand-in: weekday bars at a fixed level per symbol (adjusted closes at
    ``adjust`` x the level); ``fail`` symbols raise."""

    def __init__(self, fail: dict[str, Exception] | None = None, levels=None, adjust="0.9") -> None:
        self.fail = fail or {}
        self.levels = dict(LEVELS if levels is None else levels)
        self.adjust = None if adjust is None else Decimal(adjust)
        self.calls: list[tuple[str, dt.date, dt.date]] = []

    def chart(self, symbol, start, end, *, instrument_id="chart"):
        self.calls.append((symbol, start, end))
        if symbol in self.fail:
            raise self.fail[symbol]
        level = self.levels.get(symbol)
        bars = ()
        if level is not None:
            bars = tuple(
                PriceBar(
                    instrument_id=instrument_id,
                    date=day,
                    close=Decimal(level),
                    source="yahoo",
                    currency=Currency.USD,
                )
                # one bar outside the window on each side: the refresh keeps only the window
                for day in weekdays(start - dt.timedelta(days=3), end + dt.timedelta(days=3))
            )
        adjusted = (
            ()
            if self.adjust is None
            else tuple((b.date, (b.close * self.adjust).quantize(Decimal("0.0001"))) for b in bars)
        )
        return ChartQuote(symbol, Currency.USD, None, None, None, bars, adjusted=adjusted)


# --------------------------------------------------------------------------- #
# The plan (no DB)
# --------------------------------------------------------------------------- #


def test_window_is_always_the_whole_backfill():
    as_of = dt.date(2026, 10, 8)
    assert window_start(as_of) == as_of - dt.timedelta(days=BACKFILL_DAYS) == dt.date(2021, 10, 4)


def test_refresh_fetches_the_window_and_stores_adjusted_closes_for_etfs():
    as_of = dt.date(2026, 10, 8)
    chart = FakeChart()
    report = refresh_macro(chart, as_of)
    assert [f.series for f in report.series] == list(SERIES_KEYS)
    assert {c[1:] for c in chart.calls} == {(as_of - dt.timedelta(days=BACKFILL_DAYS), as_of)}
    by = {f.series: f for f in report.series}
    acwi = by["acwi"]
    assert acwi.status == FetchStatus.OK and acwi.source == "yahoo" and acwi.adjusted
    assert acwi.closes[0][0] >= window_start(as_of) and acwi.closes[-1][0] <= as_of
    assert [d for d, _ in acwi.closes] == sorted(d for d, _ in acwi.closes)
    assert acwi.closes[-1][1] == Decimal("99.45")  # adjusted (0.9 x 110.5)
    assert by["eem"].adjusted and by["dbc"].adjusted
    # indices and yields keep the raw close
    assert not by["spx"].adjusted and by["spx"].closes[-1][1] == Decimal(5600)
    assert by["us10y"].closes[-1][1] == Decimal("4.231")
    assert report.to_stats()["series_ok"] == 7 and report.error_messages == []
    # an answer without adjclose: the raw close, flagged
    raw = {f.series: f for f in refresh_macro(FakeChart(adjust=None), as_of).series}["dbc"]
    assert raw.closes[-1][1] == Decimal("22.3") and raw.adjusted and "raw close" in raw.message


def test_refresh_errors_are_entries_never_exceptions():
    as_of = dt.date(2026, 10, 8)
    chart = FakeChart(
        fail={"DX-Y.NYB": SourceException("yahoo", "no such symbol"), "^IRX": ValueError("bad")},
        levels={k: v for k, v in LEVELS.items() if k != "DBC"},
    )
    report = refresh_macro(chart, as_of)
    assert len(chart.calls) == 7  # a non-retryable error never trips the breaker
    by_key = {f.series: f for f in report.series}
    assert by_key["dxy"].status == FetchStatus.ERROR
    assert by_key["dxy"].message == "yahoo: no such symbol"
    assert by_key["us3m"].status == FetchStatus.ERROR and "ValueError" in by_key["us3m"].message
    assert by_key["dbc"].status == FetchStatus.NO_DATA and by_key["dbc"].closes == ()
    assert by_key["acwi"].status == FetchStatus.OK
    assert report.to_stats() == {
        "series_ok": 4,
        "series_no_data": 1,
        "series_error": 2,
        "series_skipped": 0,
        "bars_fetched": sum(len(f.closes) for f in report.series),
    }
    assert report.error_messages == [
        "macro dxy (DX-Y.NYB): yahoo: no such symbol",
        "macro us3m (^IRX): ValueError: bad",
    ]
    assert by_key["dxy"].to_json()["status"] == "error"


@pytest.mark.parametrize(
    "error",
    [
        SourceBlockedException("yahoo", "HTTP 403"),
        SourceException("yahoo", "timed out", retryable=True),
    ],
)
def test_a_blocked_or_retryable_failure_stops_the_remaining_series(error):
    as_of = dt.date(2026, 10, 8)
    chart = FakeChart(fail={"^GSPC": error})
    report = refresh_macro(chart, as_of)
    assert [c[0] for c in chart.calls] == ["ACWI", "^GSPC"]
    assert [(f.series, f.status) for f in report.series] == [
        ("acwi", FetchStatus.OK),
        ("spx", FetchStatus.ERROR),
        ("dxy, eem, dbc, us10y, us3m", FetchStatus.SKIPPED),
    ]
    skipped = report.series[-1]
    assert skipped.symbol == "DX-Y.NYB, EEM, DBC, ^TNX, ^IRX" and skipped.closes == ()
    assert skipped.message == SKIPPED_MESSAGE
    stats = report.to_stats()
    assert (stats["series_ok"], stats["series_error"], stats["series_skipped"]) == (1, 1, 5)
    assert report.error_messages == [f"macro spx (^GSPC): yahoo: {error.message}"]


def test_the_production_macro_source_has_a_short_timeout():
    sources = daily.default_sources()
    try:
        http = sources.macro._http
        assert (http.timeout, http.max_retries) == (TIMEOUT_SECONDS, MAX_RETRIES) == (10.0, 1)
    finally:
        sources.close()


# --------------------------------------------------------------------------- #
# The daily check
# --------------------------------------------------------------------------- #


@pytest.fixture
def investor(db_engine):
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


def run(chart=None, fx=None, prices=None, **kwargs) -> daily.DailyCheckReport:
    src = daily.MarketSources(prices or FakePrices(), fx or FakeFx(), macro=chart)
    return daily.run_daily_check("worker", as_of=AS_OF, sources=src, **kwargs)


def stored() -> dict[str, list[InvMacroBar]]:
    with get_session() as s:
        rows = s.exec(select(InvMacroBar).order_by(InvMacroBar.series, InvMacroBar.date)).all()
    out: dict[str, list[InvMacroBar]] = {}
    for r in rows:
        out.setdefault(r.series, []).append(r)
    return out


def test_daily_check_fetches_the_whole_window_every_run(investor):
    chart, fx = FakeChart(), FakeFx()
    report = run(chart, fx)
    assert {c[0] for c in chart.calls} == set(LEVELS)
    assert all(c[1] == AS_OF - dt.timedelta(days=BACKFILL_DAYS) for c in chart.calls)
    rows = stored()
    assert set(rows) == set(SERIES_KEYS)
    acwi = rows["acwi"]
    assert acwi[0].date >= AS_OF - dt.timedelta(days=BACKFILL_DAYS) and acwi[-1].date == AS_OF
    assert acwi[-1].close == Decimal("99.45") and acwi[-1].source == "yahoo"  # adjusted close
    assert rows["spx"][-1].close == Decimal(5600)
    assert acwi[-1].fetched_at is not None
    assert report.macro is not None and report.macro_stats["macro_bars_written"] > 7 * 500
    out = report.to_dict()
    assert out["macro"]["series_ok"] == 7 and out["macro_errors"] == []
    assert report.profiles[0].status == "ok"
    # USD/PLN for the dollar card: USD joins the FX refresh with history back to the macro window
    usd = [c for c in fx.calls if c[0] == "USD"]
    assert min(c[1] for c in usd) <= AS_OF - dt.timedelta(days=BACKFILL_DAYS)

    chart2 = FakeChart()
    run(chart2)
    assert {c[1] for c in chart2.calls} == {AS_OF - dt.timedelta(days=BACKFILL_DAYS)}
    assert len(chart2.calls) == 7
    assert len(stored()["acwi"]) == len(acwi)  # upserted, not duplicated


def test_offline_and_sources_without_macro_skip_it(investor):
    chart = FakeChart()
    report = run(chart, offline=True)
    assert chart.calls == [] and report.macro is None and stored() == {}
    fx = FakeFx()
    report = run(None, fx)
    assert report.macro is None and report.to_dict()["macro"] is None and stored() == {}
    assert not any(c[0] == "USD" and c[1] < AS_OF - dt.timedelta(days=400) for c in fx.calls)


def test_a_failing_series_never_aborts_the_run(investor):
    chart = FakeChart(fail={"^TNX": SourceException("yahoo", "HTTP 429")})
    report = run(chart)
    assert set(stored()) == set(SERIES_KEYS) - {"us10y"}
    assert report.to_dict()["macro_errors"] == ["macro us10y (^TNX): yahoo: HTTP 429"]
    assert report.profiles[0].status == "ok"  # macro errors are not profile run errors
    assert not any("macro" in e for e in report.profiles[0].errors)


def test_an_unexpected_macro_failure_keeps_the_run(investor, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(daily, "refresh_macro", broken)
    report = run(FakeChart())
    assert report.macro is None and report.macro_error == "RuntimeError: boom"
    assert report.profiles[0].status == "ok" and report.market is not None


def test_no_transaction_is_held_while_fetching_macro(investor):
    from cashu.core.db import make_engine
    from cashu.db import engine

    probe = make_engine(str(engine.url))
    writes: list[str] = []

    class Probing(FakeChart):
        def chart(self, symbol, start, end, *, instrument_id="chart"):
            with probe.connect() as c:
                c.exec_driver_sql("PRAGMA busy_timeout=100")
                c.exec_driver_sql("CREATE TABLE IF NOT EXISTS probe (x INTEGER)")
                c.exec_driver_sql("INSERT INTO probe VALUES (1)")
                c.commit()
            writes.append(symbol)
            return super().chart(symbol, start, end, instrument_id=instrument_id)

    report = run(Probing())
    assert len(writes) == len(SERIES) and report.macro is not None
    probe.dispose()


def test_refresh_and_store_and_the_store_reads(db_engine):
    chart = FakeChart()
    report, counts = macro_service.refresh_and_store(chart, AS_OF, session_factory=get_session)
    assert counts["macro_bars_written"] == report.to_stats()["bars_fetched"] > 0
    with get_session() as s:
        last = macro_store.last_dates(s)
        version = macro_store.data_version(s)
        closes = macro_store.closes(s, until=AS_OF, since=AS_OF - dt.timedelta(days=30))
    assert last == dict.fromkeys(SERIES_KEYS, AS_OF)
    assert set(closes) == set(SERIES_KEYS)  # no USD/PLN stored yet
    assert all(d >= AS_OF - dt.timedelta(days=30) for d, _ in closes["dbc"])
    assert closes["us10y"][-1] == (AS_OF, 4.231)
    macro_service.refresh_and_store(
        FakeChart(levels={"ACWI": "111"}), AS_OF, session_factory=get_session
    )
    with get_session() as s:
        assert macro_store.data_version(s) != version
        assert macro_store.closes(s, until=AS_OF)["acwi"][-1] == (AS_OF, 99.9)


def test_a_restated_adjusted_history_rescales_the_older_stored_bars(db_engine):
    start = window_start(AS_OF)
    older = [start - dt.timedelta(days=d) for d in (30, 20, 10)]
    with get_session() as s:
        macro_store.upsert(s, "acwi", [(d, "50") for d in older], source="t", now=utcnow())
        macro_store.upsert(s, "spx", [(d, "4000") for d in older], source="t", now=utcnow())
    # first fetch: nothing stored inside the window yet, nothing to rescale
    _report, counts = macro_service.refresh_and_store(
        FakeChart(), AS_OF, session_factory=get_session
    )
    assert counts["macro_bars_rescaled"] == 0
    # a new payout: Yahoo restates the whole adjusted history by 0.9
    _report, counts = macro_service.refresh_and_store(
        FakeChart(adjust="0.81"), AS_OF, session_factory=get_session
    )
    assert counts["macro_bars_rescaled"] == 3
    with get_session() as s:
        closes = macro_store.closes(s, until=AS_OF)
    assert [v for d, v in closes["acwi"] if d < start] == [45.0, 45.0, 45.0]
    assert [v for d, v in closes["spx"] if d < start] == [4000.0] * 3  # raw series untouched
    # the same answer again changes nothing
    _report, counts = macro_service.refresh_and_store(
        FakeChart(adjust="0.81"), AS_OF, session_factory=get_session
    )
    assert counts["macro_bars_rescaled"] == 0


def test_a_failing_macro_write_keeps_the_market_data_and_the_run(investor, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(macro_store, "apply_report", broken)
    report = run(FakeChart())
    assert report.macro_error == "RuntimeError: disk full" and report.macro is not None
    assert report.market_stats["bars_written"] > 0 and report.profiles[0].status == "ok"
    assert stored() == {}


def test_yahoo_chart_exposes_the_adjusted_close_without_changing_the_bars():
    from pathlib import Path

    from cashu.modules.investments.market import YahooPriceSource

    body = (
        Path(__file__).resolve().parents[1] / "fixtures" / "market" / "yahoo_aapl.json"
    ).read_text()
    source = YahooPriceSource(None)  # parsing only, no HTTP
    wide = (dt.date(2000, 1, 1), dt.date(2100, 1, 1))
    quote = source.parse_chart(body, "AAPL", *wide)
    assert quote.adjusted and [d for d, _ in quote.adjusted] == [b.date for b in quote.bars]
    assert all(isinstance(v, Decimal) for _, v in quote.adjusted)

    def plain(bars):
        return [(b.date, b.close, b.open, b.volume) for b in bars]

    # a body without adjclose: empty, the bars unaffected
    import json

    data = json.loads(body)
    del data["chart"]["result"][0]["indicators"]["adjclose"]
    bare = source.parse_chart(json.dumps(data), "AAPL", *wide)
    assert bare.adjusted == () and plain(bare.bars) == plain(quote.bars)
