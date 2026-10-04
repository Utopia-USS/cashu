"""The investments NetWorthContributor: brokerage accounts in net worth (holdings + broker cash in the
account currency), history on month ends, fallback to core balances."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from invp_support import AS_OF, add_account, canonical_csv, import_file, make_profile, sources

from finanse.core import networth
from finanse.core.accounts import upsert_balance
from finanse.core.db import get_session
from finanse.core.models import Account, Source
from finanse.modules.investments import networth as inv_networth
from finanse.modules.investments.service import accounts, daily


@pytest.fixture
def priced(db_engine, monkeypatch):
    """A profile with the synthetic history and stored prices / rates up to AS_OF."""
    monkeypatch.setattr(inv_networth, "_today", lambda: AS_OF)
    pid, _ = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    daily.run_daily_check("cli", as_of=AS_OF, sources=sources())
    return pid, aid


def test_brokerage_account_value_in_net_worth(priced):
    pid, aid = priced
    with get_session() as s:
        totals, lines = networth.net_worth(s, profile_id=pid)
        (line,) = [ln for ln in lines if ln.account.id == aid]
        breakdown = networth.net_worth_breakdown(s, profile_id=pid)
    # ABC 100 x 60 + WRLD 10 x 110 EUR x 4.3 + XMPL 20 x 100 USD x 4.0 + cash 2695 PLN + 8.5 USD x 4.0
    assert totals == {"PLN": Decimal("21459.000")}
    assert line.as_of == AS_OF and line.contribution == Decimal("21459.000")
    assert breakdown.by_type == {"brokerage": Decimal("21459.000")} and breakdown.assets == Decimal(
        "21459.000"
    )


def test_value_as_of_a_past_date(priced):
    pid, _ = priced
    with get_session() as s:
        totals, _ = networth.net_worth(s, as_of=dt.date(2026, 1, 6), profile_id=pid)
        before, _ = networth.net_worth(s, as_of=dt.date(2026, 1, 1), profile_id=pid)
    assert totals == {"PLN": Decimal("20000.00")}  # only the deposit so far
    assert before == {}  # nothing before the first transaction


def test_series_on_month_ends(priced):
    pid, _ = priced
    with get_session() as s:
        series = networth.net_worth_component_series(s, profile_id=pid)
    assert [d for d, _ in series] == [dt.date(2026, 1, 31), dt.date(2026, 2, 28), AS_OF]
    assert all(comps == {"investments": Decimal("21459.000")} for _, comps in series)


def test_account_in_another_currency_is_valued_in_it(db_engine, monkeypatch):
    monkeypatch.setattr(inv_networth, "_today", lambda: AS_OF)
    pid, _ = make_profile()
    with get_session() as s:
        aid = accounts.add_account(s, pid, name="USD", broker="xtb", currency="USD").id
    import_file(pid, aid, canonical_csv())
    daily.run_daily_check("cli", as_of=AS_OF, sources=sources())
    with get_session() as s:
        totals, _ = networth.net_worth(s, profile_id=pid)
    # 2000 (XMPL) + 6000 PLN / 4 + 1100 EUR x 4.3 / 4.0 + 2695 PLN / 4 + 8.5
    assert totals == {"USD": Decimal("5364.75")}


def test_without_transactions_core_balances_apply(db_engine):
    pid, _ = make_profile()
    aid = add_account(pid)
    with get_session() as s:
        acc = s.get(Account, aid)
        upsert_balance(s, acc, dt.date(2026, 2, 1), Decimal("1234.00"), source=Source.MANUAL)
    with get_session() as s:
        totals, _ = networth.net_worth(s, profile_id=pid)
    assert totals == {"PLN": Decimal("1234.00")}


def test_api_networth_includes_brokerage(priced, api_empty):
    pid, _ = priced
    from finanse.core import profiles

    with get_session() as s:
        slug = s.get(profiles.Profile, pid).slug
    body = api_empty.get(f"/api/p/{slug}/networth").json()
    assert body["totals"] == {"PLN": 21459.0}
    assert body["accounts"][0]["type"] == "brokerage"
    series = api_empty.get(f"/api/p/{slug}/networth/series").json()
    assert series["components"] == [
        {"key": "investments", "label": "Inwestycje", "liability": False}
    ]


def test_month_ends():
    assert inv_networth.month_ends(dt.date(2025, 11, 15), dt.date(2026, 2, 3)) == [
        dt.date(2025, 11, 30),
        dt.date(2025, 12, 31),
        dt.date(2026, 1, 31),
    ]
    assert inv_networth.month_ends(dt.date(2026, 1, 1), dt.date(2026, 1, 31)) == []
