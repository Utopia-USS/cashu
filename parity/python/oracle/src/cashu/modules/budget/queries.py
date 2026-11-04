"""Profile-scoped query helpers for budget tables (transactions belong to a
profile through their account)."""

from __future__ import annotations

from sqlmodel import select

from cashu.core.profiles import account_ids_query

from .models import Transaction


def transactions(profile_id: int, *conditions):
    """``select(Transaction)`` limited to the profile's accounts."""
    return select(Transaction).where(
        Transaction.account_id.in_(account_ids_query(profile_id)), *conditions
    )
