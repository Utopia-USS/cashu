"""Loans' blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlmodel import Session, select

from finanse.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix
from finanse.core.profiles import account_ids_query

from .models import Loan
from .patterns import LOANS_CATEGORY


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    loans = session.exec(
        select(Loan).where(Loan.account_id.in_(account_ids_query(profile_id)))
    ).all()
    return SetupStatus(steps=(
        SetupStep(
            "loan",
            "Dodaj kredyt",
            "Kwota, oprocentowanie, rata, data startu.",
            done=bool(loans),
            actions=(SetupAction(
                "cli", "Kopiuj polecenie",
                f'{cli} loans add "Hipoteka" --type mortgage --principal 400000 --rate 6.5 '
                "--years 25 --start 2025-01-05",
            ),),
        ),
        SetupStep(
            "payments",
            "Wskaż konto raty",
            "IBAN albo fraza z tytułu raty; raty liczą się jako spłata, nie subskrypcja.",
            done=bool(loans) and (
                any(loan.payment_iban or loan.payment_text for loan in loans)
                or _has_categorized_installments(session, profile_id)
            ),
            actions=(SetupAction(
                "cli", "Kopiuj polecenie", f'{cli} loans set-payment KREDYT_ID --text "RATA KREDYTU"'
            ),),
        ),
    ))


def _has_categorized_installments(session: Session, profile_id: int) -> bool:
    """Installments already recognised (e.g. by the built-in phrases)? Reads the
    budget's table by name (every module's tables always exist; loans does not
    import budget code)."""
    from sqlalchemy import text

    row = session.exec(
        text(
            "SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id "
            "WHERE a.profile_id = :pid AND t.category = :cat LIMIT 1"
        ).bindparams(pid=profile_id, cat=LOANS_CATEGORY)
    ).first()
    return row is not None
