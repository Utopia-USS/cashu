"""Loans' blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlmodel import Session, select

from finanse.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix
from finanse.core.profiles import account_ids_query

from .models import Loan


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    loans = session.exec(
        select(Loan).where(Loan.account_id.in_(account_ids_query(profile_id)))
    ).all()
    return SetupStatus(steps=(
        SetupStep(
            "loan",
            "Dodaj kredyt (kwota, oprocentowanie, rata, start)",
            "Hipoteka, kredyt samochodowy lub gotówkowy. Wiele kredytów na profil.",
            done=bool(loans),
            actions=(SetupAction(
                "cli", "Kopiuj polecenie",
                f'{cli} set-loan KONTO_ID 400000 6.5 --years 25 --start 2025-01-05',
            ),),
        ),
    ))
