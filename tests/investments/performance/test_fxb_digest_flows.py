"""F6 review V4: the review digest splits the value change like the performance engine. Units moved in
(or out) and implied funding (a cash gap filled by unrecorded money) are external flows with their own
line, never the market part; deposits listed as events follow the same window as ``contributions``."""

from __future__ import annotations

import datetime as dt

import pytest
from perf_support import AS_OF, BENCH_STRATEGY, ROWS, canonical_csv, sources

from finanse.core import profiles
from finanse.core.db import get_session
from finanse.modules.investments.importing import ImportFile
from finanse.modules.investments.performance import backfill, service
from finanse.modules.investments.service import accounts, files, imports, portfolio, views

SINCE = dt.date(2025, 9, 1)
# WRLD closes at 110 EUR from April, EUR at 4.3: 473 PLN per unit
TRANSFER = (
    "1,txn,2025-09-15,10:00,transfer_in,P-6,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,"
    "5,,EUR,,,,,,,,"
)
# cash before: 8700 PLN; 30 units at 110 EUR = 14190 PLN -> 5490 PLN of cash gap
BIG_BUY = (
    "1,txn,2025-09-10,10:00,buy,P-7,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,30,110.00,EUR,"
    "3300.00,,,-14190.00,PLN,4.3,,"
)
DEPOSIT_ON_SINCE = "1,txn,2025-09-01,09:00,deposit,P-8,,,,,,,PLN,,,,500.00,,,,"


@pytest.fixture(autouse=True)
def _today(db_engine, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    service.clear_cache()
    yield
    service.clear_cache()


def _profile(name: str, extra: list[str]) -> int:
    with get_session() as s:
        p = profiles.create_profile(s, name=name, modules_=["investments"])
        pid, slug = p.id, p.slug
    with get_session() as s:
        aid = accounts.add_account(s, pid, name="Konto Test", broker="dif").id
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        preview = imports.preview(
            s,
            profile,
            imports.ImportRequest(ImportFile("history.csv", canonical_csv([*ROWS, *extra])), aid),
        )
    imports.commit(preview)
    files.write_text_private(files.strategy_yaml_path(slug), BENCH_STRATEGY)
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    return pid


def _digest(pid: int) -> dict:
    with get_session() as s:
        return views.review_digest(s, s.get(profiles.Profile, pid), since_date=SINCE)


def test_units_moved_in_are_not_the_market_part():
    v = _digest(_profile("Anna", [TRANSFER]))["value"]
    assert (v["then"], v["now"]) == (13430.0, 15795.0)
    assert v["contributions"] == 0.0
    assert v["transfers"] == pytest.approx(5 * 473.0)
    assert v["implied_funding"] == 0.0
    assert v["market_change"] == pytest.approx(0.0, abs=0.01)
    assert v["market_change_pct"] == pytest.approx(0.0, abs=1e-6)


def test_implied_funding_is_not_the_market_part():
    v = _digest(_profile("Basia", [BIG_BUY]))["value"]
    # then 13430; now: cash floored at 0 + 40 units * 473 = 18920
    assert (v["then"], v["now"]) == (13430.0, 18920.0)
    assert v["contributions"] == 0.0 and v["transfers"] == 0.0
    assert v["implied_funding"] == pytest.approx(5490.0)
    assert v["market_change"] == pytest.approx(0.0, abs=0.01)


def test_deposit_events_follow_the_contributions_window():
    d = _digest(_profile("Cela", [DEPOSIT_ON_SINCE]))
    # dated on the baseline day: part of the value then, so neither a contribution nor an event
    assert d["value"]["contributions"] == 0.0
    assert not [e for e in d["events"] if e.get("type") == "deposit"]
