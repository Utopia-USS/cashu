"""F6 review V7: a cushion kept on the income account never counts the month's surplus twice. The cushion
level is the balance as of the month start plus the month's transfers on the cushion accounts; F7 review
R5: a transfer out that funded spending on another own account (cash pool, a spending card) is added
back up to that spending, so moving the suggested transfer out leaves the cushion at its target.

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
    # 5000 at the start, 1300 moved out during the month (1000 to savings, 300 ATM of which 40 was
    # spent from the cash pool and is in the surplus): 5000 - 1300 + 40; the surplus is not part of it
    assert c["balance"] == 3740.0 and c["missing"] == 1260.0
    assert pln["surplus"] == 4724.25
    assert pln["cushion_top_up"] == 1260.0 and pln["suggested_transfer"] == 3464.25
    # moving the suggested amount out leaves the account exactly at the target
    assert 5000 + 9000 - 4235.75 - 1300 - pln["suggested_transfer"] == c["target"]


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
    assert c["balance"] == pytest.approx(4930 - 1300 + 40)


def test_savings_cushion_is_unchanged(api):
    # month-end 24000; with a balance before the month: 23000 + the 1000 moved in = the same level
    _put(api, {"enabled": True, "target_amount": 30000})
    before = api.get(SEPT).json()["cushion"]
    assert before["balance"] == 24000.0
    _balance("Erste Test", date(2026, 8, 31), "23000.00")
    after = api.get(SEPT).json()
    assert after["cushion"]["balance"] == 24000.0
    assert _pln(after)["cushion_top_up"] == min(6000.0, _pln(after)["surplus"])


IBAN_SPENDING = "99999000000000000000000004"


def test_a_transfer_that_funds_spending_on_another_own_account_is_no_cushion_outflow(api):
    """F7 review R5 probe: 2000 moved from the checking cushion to an own spending account and spent
    there by card in the same month; the spending is in the surplus, so the transfer is added back."""
    from finanse.modules.budget import service as budget
    from finanse.modules.budget.ingestion.normalize import RawTransaction
    from finanse.modules.budget.ingestion.transfers import match_internal_transfers

    with get_session() as s:
        main = s.exec(select(Account).where(Account.name == "mKonto Test")).one()
        spend = accounts.get_or_create_account(
            s, bank="revolut", iban=IBAN_SPENDING, name="Konto Wydatki Test",
            profile_id=main.profile_id,
        )

        def raw(day: int, amount: str, ref: str, iban: str | None = None) -> RawTransaction:
            return RawTransaction(
                booking_date=date(2026, 9, day), amount=Decimal(amount), currency="PLN",
                counterparty_iban=iban, reference=ref, source=Source.CSV,
            )

        budget.ingest_transactions(
            s, main, [raw(12, "-2000.00", "ZASILENIE KONTA", IBAN_SPENDING)], source=Source.CSV
        )
        budget.ingest_transactions(
            s, spend,
            [raw(12, "2000.00", "ZASILENIE KONTA", "99114000000000000000000001"),
             raw(18, "-2000.00", "SKLEP RTV TEST")],
            source=Source.CSV,
        )
        match_internal_transfers(s, profile_id=main.profile_id)
        budget.categorize_all(s, profile_id=main.profile_id)
        s.commit()
        main_id = main.id
    _balance("mKonto Test", date(2026, 8, 31), "5000.00")
    _put(api, {"enabled": True, "target_amount": 5000, "account_ids": [main_id]})
    close = api.get(SEPT).json()
    c, pln = close["cushion"], _pln(close)
    assert pln["surplus"] == 2724.25
    assert c["balance"] == 3740.0 and pln["cushion_top_up"] == 1260.0
    assert pln["suggested_transfer"] == 1464.25
    # the account holds 6464.25 at the month end: the suggested amount leaves it at the target
    assert 5000 + 9000 - 4235.75 - 1300 - 2000 - pln["suggested_transfer"] == c["target"]

