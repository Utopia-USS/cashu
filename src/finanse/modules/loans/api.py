"""Loans API routes: every loan of the profile, and the legacy single-loan view."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from finanse.core.api import CurrentProfile
from finanse.core.db import get_session

from .service import list_loans, loan_summary

router = APIRouter()


@router.get("/loans")
def loans(profile: CurrentProfile) -> list[dict]:
    """Every loan of the profile (oldest first), each in the ``/loan`` shape plus
    ``id``, ``account_id``, ``name`` (the account name) and ``type``."""
    today = date.today()  # noqa: DTZ011 - naive local date, like the booking dates
    with get_session() as s:
        return [loan_summary(s, loan, acc, today) for loan, acc in list_loans(s, profile.id)]


@router.get("/loan")
def loan_info(profile: CurrentProfile) -> dict:
    """The profile's first loan (upstream shape, kept for the legacy dashboard)."""
    today = date.today()  # noqa: DTZ011 - naive local date, like the booking dates
    with get_session() as s:
        rows = list_loans(s, profile.id)
        if not rows:
            return {"has_loan": False}
        loan, acc = rows[0]
        return loan_summary(s, loan, acc, today)
