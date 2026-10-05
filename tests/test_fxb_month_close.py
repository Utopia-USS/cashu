"""F6 review V7: a cushion kept on the income account never counts the month's surplus twice. The cushion
level is the balance as of the month start plus the month's transfers on the cushion accounts.

Synthetic household (conftest.seed_demo), September 2026 on the PLN checking account "mKonto Test":
income 9000, spending 4235.75 (card, rent, mortgage, fees), transfers out 1300 (1000 to savings, 300 ATM);
the profile's PLN surplus is 4724.25 (40 of cash spending sits on the cash pool)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import select

from finanse.core import accounts
from finanse.db import get_session
from finanse.models import Account, Source

SEPT = "/api/budget/month-close?month=2026-09"


def _account(name: str) -> Account:
    with get_session() as s:
        return s.exec(select(Account).where(Account.name == name)).one()


def _balance(name: str, day: date, amount: str) -> None:
    with get_session() as s:
        acc = s.exec(select(Account).where(Account.name == name)).one()
        accounts.upsert_balance(s, acc, day, Decimal(amount), source=Source.CSV)
        s.commit()


def _put(api, cushion: dict) -> None:
    r = api.put("/api/budget/settings", json={"cushion": cushion})
    assert r.status_code == 200, r.text


def _pln(close: dict) -> dict:
    return next(c for c in close["currencies"] if c["currency"] == "PLN")


def test_checking_cushion_counts_the_month_start_plus_transfers(api):
    _balance("mKonto Test", date(2026, 8, 31), "5000.00")
    main = _account("mKonto Test").id
    _put(api, {"enabled": True, "target_amount": 5000, "account_ids": [main]})
    close = api.get(SEPT).json()
    c, pln = close["cushion"], _pln(close)
    # 5000 at the start, 1300 moved out during the month; the month's surplus is not part of it
    assert c["balance"] == 3700.0 and c["missing"] == 1300.0
    assert pln["surplus"] == 4724.25
    assert pln["cushion_top_up"] == 1300.0 and pln["suggested_transfer"] == 3424.25
    # moving the suggested amount out keeps the account at the target (5000 + 9000 - 4235.75 - 1300
    # - 3424.25 = 5040; the 40 of cash spending is not booked on it)
    assert 5000 + 9000 - 4235.75 - 1300 - pln["suggested_transfer"] >= c["target"]


def test_a_full_checking_cushion_does_not_hold_back_the_surplus(api):
    _balance("mKonto Test", date(2026, 8, 31), "6300.00")
    main = _account("mKonto Test").id
    _put(api, {"enabled": True, "target_amount": 5000, "account_ids": [main]})
    pln = _pln(api.get(SEPT).json())
    assert pln["cushion_top_up"] == 0.0 and pln["suggested_transfer"] == 4724.25


def test_an_older_snapshot_is_rolled_forward_to_the_month_start(api):
    # 2026-08-20 snapshot 5200 (end of that day); after it in August: -208 fuel (21st), -55 unknown
    # shop (25th), -7 fee (28th): 5200 - 270 = 4930 at the month start
    _balance("mKonto Test", date(2026, 8, 20), "5200.00")
    main = _account("mKonto Test").id
    _put(api, {"enabled": True, "target_amount": 5000, "account_ids": [main]})
    c = api.get(SEPT).json()["cushion"]
    assert c["balance"] == pytest.approx(4930 - 1300)


def test_savings_cushion_is_unchanged(api):
    # month-end 24000; with a balance before the month: 23000 + the 1000 moved in = the same level
    _put(api, {"enabled": True, "target_amount": 30000})
    before = api.get(SEPT).json()["cushion"]
    assert before["balance"] == 24000.0
    _balance("Erste Test", date(2026, 8, 31), "23000.00")
    after = api.get(SEPT).json()
    assert after["cushion"]["balance"] == 24000.0
    assert _pln(after)["cushion_top_up"] == min(6000.0, _pln(after)["surplus"])
