"""Budget's net-worth contributor: the cash pool is worth its running sum."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from cashu.core import account_types
from cashu.core.models import Account
from cashu.core.networth import RunningValuation, Valuation

from .models import Transaction

ZERO = Decimal("0.00")


class CashContributor:
    def valuations(
        self, session: Session, accounts: Mapping[int, Account]
    ) -> dict[int, Valuation]:
        cash_ids = [
            aid for aid, a in accounts.items() if account_types.type_id(a.type) == "cash"
        ]
        if not cash_ids:
            return {}
        txns: dict[int, list[Transaction]] = {aid: [] for aid in cash_ids}
        for t in session.exec(select(Transaction).where(Transaction.account_id.in_(cash_ids))):
            txns[t.account_id].append(t)
        out: dict[int, Valuation] = {}
        for aid, rows in txns.items():
            by_date: dict[date, Decimal] = {}
            run = ZERO
            for t in sorted(rows, key=lambda t: (t.booking_date, t.id or 0)):
                run += t.amount
                by_date[t.booking_date] = run
            out[aid] = RunningValuation(sorted(by_date.items()))
        return out
