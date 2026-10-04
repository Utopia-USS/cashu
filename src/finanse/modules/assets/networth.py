"""Assets' net-worth contributor: a vehicle is worth its depreciated value."""

from __future__ import annotations

from collections.abc import Mapping

from sqlmodel import Session, select

from finanse.core.models import Account
from finanse.core.networth import ComputedValuation, Valuation

from . import depreciation
from .models import Depreciation


class AssetsContributor:
    def valuations(
        self, session: Session, accounts: Mapping[int, Account]
    ) -> dict[int, Valuation]:
        out: dict[int, Valuation] = {}
        if not accounts:
            return out
        rows = session.exec(
            select(Depreciation).where(Depreciation.account_id.in_(list(accounts)))
        ).all()
        for dep in rows:
            out[dep.account_id] = ComputedValuation(
                lambda d, dep=dep: depreciation.value_of(dep, d)
            )
        return out
