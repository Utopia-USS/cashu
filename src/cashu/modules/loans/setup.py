"""Loans' blank-page steps (``ModuleSpec.setup_status``). Copy is UI data in the request's language
(``core.i18n.tr``); the example title phrase ``RATA KREDYTU`` stays Polish (it matches Polish bank
transfer titles)."""

from __future__ import annotations

from sqlmodel import Session, select

from cashu.core import profiles
from cashu.core.i18n import tr
from cashu.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix
from cashu.core.profiles import account_ids_query

from .models import Loan
from .patterns import LOANS_CATEGORY


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    loans = session.exec(
        select(Loan).where(Loan.account_id.in_(account_ids_query(profile_id)))
    ).all()
    copy = tr(pl="Kopiuj polecenie", en="Copy command")
    steps = [
        SetupStep(
            "loan",
            tr(pl="Kredyt", en="Loan"),
            tr(
                pl="Kwota, oprocentowanie, okres, pierwsza rata.",
                en="Amount, interest rate, term, first installment.",
            ),
            done=bool(loans),
            actions=(SetupAction(
                "cli", copy,
                f'{cli} loans add "{tr(pl="Hipoteka", en="Mortgage")}" --type mortgage --principal 400000 --rate 6.5 '
                "--years 25 --start 2025-01-05",
            ),),
        ),
    ]
    # Installments are recognised in bank transactions: without the budget module there is nothing
    # to recognise them in (first steps L4).
    if "budget" in profiles.enabled_modules(session, profile_id):
        steps.append(SetupStep(
            "payments",
            tr(pl="Rozpoznawanie rat", en="Recognizing installments"),
            tr(
                pl="Fraza z tytułu przelewu albo IBAN banku; raty liczą się jako spłata, nie "
                "subskrypcja.",
                en="A phrase from the transfer title or the bank's IBAN; installments count as "
                "repayment, not a subscription.",
            ),
            done=bool(loans) and (
                any(loan.payment_iban or loan.payment_text for loan in loans)
                or _has_categorized_installments(session, profile_id)
            ),
            actions=(SetupAction(
                "cli", copy,
                f"{cli} loans set-payment {tr(pl='KREDYT_ID', en='LOAN_ID')} "
                '--text "RATA KREDYTU"',
            ),),
        ))
    return SetupStatus(steps=tuple(steps))


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
