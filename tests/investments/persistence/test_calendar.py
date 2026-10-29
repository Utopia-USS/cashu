"""Market calendar of the weekly review (market/calendar.py): feed parsing, the cache, matching
earnings to the profile's own instruments. Feeds are synthetic; nothing touches the network."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from invp_support import make_profile

from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.modules.investments.market import calendar
from cashu.modules.investments.models import InvInstrument, InvInstrumentAlias, InvWatchlistItem

TODAY = dt.date(2026, 11, 1)


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch):
    """Each test starts without a cached feed (the data dir is shared by the session)."""
    monkeypatch.setattr(calendar, "cache_path", lambda: tmp_path / "market" / calendar.CACHE_FILE)


def test_ff_feed_keeps_high_impact_releases_of_the_big_economies_with_polish_names():
    body = json.dumps(
        [
            {"title": "Federal Funds Rate", "country": "USD", "date": "2026-11-04T14:00:00-04:00", "impact": "High"},
            {"title": "FOMC Press Conference", "country": "USD", "date": "2026-11-04T14:30:00-04:00", "impact": "High"},
            {"title": "CPI y/y", "country": "EUR", "date": "2026-11-03T05:00:00-05:00", "impact": "High"},
            {"title": "Official Cash Rate", "country": "NZD", "date": "2026-11-03T20:00:00-05:00", "impact": "High"},
            {"title": "German ifo Business Climate", "country": "EUR", "date": "2026-11-03T05:00:00-05:00", "impact": "Low"},
            {"title": "Unemployment Rate", "country": "USD", "date": "2026-11-06T08:30:00-05:00", "impact": "High"},
            {"title": "Something New", "country": "GBP", "date": "2026-11-05T07:00:00-05:00", "impact": "High"},
        ]
    )
    rows = calendar.parse_ff(body)
    assert [(r["country"], r["title"]) for r in rows] == [
        ("USD", "Fed: decyzja o stopach"),
        ("USD", "Fed: decyzja o stopach"),
        ("EUR", "inflacja CPI"),
        ("USD", "rynek pracy"),
        ("GBP", "Something New"),
    ]
    assert all(len(r["time"]) == 5 for r in rows)


def test_central_bank_meetings_fold_into_one_row_per_bank_and_day():
    def fetch(today, days):
        rows = calendar.parse_ff(
            json.dumps(
                [
                    {"title": t, "country": "EUR", "date": "2026-11-05T08:15:00-04:00", "impact": "High"}
                    for t in ("Main Refinancing Rate", "Monetary Policy Statement", "ECB Press Conference")
                ]
            )
        )
        return {"fetched_at": "x", "from": "", "to": "", "macro": calendar._unique(rows, ("date", "country", "title")), "earnings": [], "errors": []}

    assert len(fetch(TODAY, 14)["macro"]) == 1


def test_nasdaq_list_parses_symbols_and_session_side():
    body = json.dumps(
        {"data": {"rows": [
            {"symbol": "xmpl", "name": "Przyklad Corp", "time": "time-after-hours"},
            {"symbol": "OTHR", "name": "Other Inc", "time": "time-pre-market"},
            {"symbol": "", "name": "Empty"},
        ]}}
    )
    assert calendar.parse_nasdaq(body, TODAY) == [
        {"date": "2026-11-01", "symbol": "XMPL", "name": "Przyklad Corp", "when": "after"},
        {"date": "2026-11-01", "symbol": "OTHR", "name": "Other Inc", "when": "pre"},
    ]


def _feeds(macro=(), earnings=(), errors=()):
    return {
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(),
        "from": TODAY.isoformat(),
        "to": (TODAY + dt.timedelta(14)).isoformat(),
        "macro": list(macro),
        "earnings": list(earnings),
        "errors": list(errors),
    }


def test_feeds_are_cached_and_a_failed_refresh_serves_the_old_cache_as_stale():
    calls = []

    def ok(today, days):
        calls.append(today)
        return _feeds(macro=[{"date": "2026-11-04", "time": "20:00", "country": "USD", "title": "Fed: decyzja o stopach"}])

    first, stale = calendar.feeds(TODAY, fetch=ok)
    again, _ = calendar.feeds(TODAY, fetch=ok)
    assert not stale and first == again and len(calls) == 1

    later = dt.datetime.now(dt.UTC) + calendar.CACHE_TTL + dt.timedelta(minutes=1)
    served, stale = calendar.feeds(TODAY, fetch=lambda t, d: _feeds(errors=["macro_unavailable", "earnings_unavailable"]), now=later)
    assert stale and served["macro"] == first["macro"]


def test_without_a_fetcher_tests_never_reach_the_network(monkeypatch):
    monkeypatch.setattr(calendar, "fetch_feeds", lambda *a, **k: pytest.fail("network"))
    data, stale = calendar.feeds(TODAY)
    assert stale and data["errors"] == ["offline"]


def _instrument(s, name, *, symbol, yahoo=None, currency="USD", mic=None) -> int:
    row = InvInstrument(name=name, currency=currency, asset_class="equity", symbol=symbol, mic=mic, valuation_mode="market")
    s.add(row)
    s.flush()
    if yahoo:
        s.add(InvInstrumentAlias(instrument_id=row.id, namespace="yahoo", value=yahoo))
    return row.id


def test_earnings_match_only_the_profiles_own_us_instruments(db_engine):
    anna, _ = make_profile("Anna")
    other, _ = make_profile("Bartek")
    with get_session() as s:
        us = _instrument(s, "Przyklad Corp", symbol="XMPL", yahoo="XMPL")
        pl = _instrument(s, "Przyklad SA", symbol="XMPL", yahoo="XMPL.WA", currency="PLN", mic="XWAR")
        s.add(InvWatchlistItem(profile_id=anna, instrument_id=us, note=None, tags=[]))
        s.add(InvWatchlistItem(profile_id=anna, instrument_id=pl, note=None, tags=[]))
        s.commit()

    feed = _feeds(
        macro=[
            {"date": "2026-11-04", "time": "20:00", "country": "USD", "title": "Fed: decyzja o stopach"},
            {"date": "2026-11-30", "time": "20:00", "country": "USD", "title": "Fed: decyzja o stopach"},
        ],
        earnings=[
            {"date": "2026-11-03", "symbol": "XMPL", "name": "Przyklad Corp", "when": "after"},
            {"date": "2026-11-03", "symbol": "OTHR", "name": "Other Inc", "when": "pre"},
        ],
    )
    with get_session() as s:
        view = calendar.calendar_view(s, s.get(Profile, anna), today=TODAY, fetch=lambda t, d: feed)
        empty = calendar.calendar_view(s, s.get(Profile, other), today=TODAY, fetch=lambda t, d: feed)

    assert [(e["date"], e["kind"]) for e in view["events"]] == [("2026-11-03", "earnings"), ("2026-11-04", "macro")]
    earning = view["events"][0]
    assert earning["instrument_id"] == us and earning["held"] is False and earning["time"] == "po sesji"
    assert [e["kind"] for e in empty["events"]] == ["macro"]  # no instrument of the other profile


def test_days_out_of_range_are_refused(db_engine):
    pid, _ = make_profile("Anna")
    with get_session() as s, pytest.raises(calendar.CalendarError):
        calendar.calendar_view(s, s.get(Profile, pid), today=TODAY, days=0, fetch=lambda t, d: _feeds())
