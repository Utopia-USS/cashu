"""Budget's blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlalchemy import func
from sqlmodel import Session, select

from cashu.core.institutions import MANUAL
from cashu.core.models import Account
from cashu.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix

from .models import CategoryRule, Transaction


def _count(session: Session, stmt) -> int:
    return int(session.exec(stmt).one() or 0)


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    bank_ids = select(Account.id).where(
        Account.profile_id == profile_id, Account.bank != MANUAL
    )
    n_bank_accounts = _count(session, select(func.count()).select_from(bank_ids.subquery()))
    bank_txns = select(func.count(Transaction.id)).where(Transaction.account_id.in_(bank_ids))
    n_txns = _count(session, bank_txns)
    n_uncategorized = _count(
        session,
        bank_txns.where(Transaction.amount < 0, Transaction.category_source == "default"),
    )
    n_manual = _count(
        session,
        select(func.count(CategoryRule.id)).where(
            CategoryRule.profile_id == profile_id, CategoryRule.source == "manual"
        ),
    ) + _count(session, bank_txns.where(Transaction.category_source == "manual_txn"))
    n_transfers = _count(session, bank_txns.where(Transaction.is_internal_transfer == True))

    # One bank account: nothing to pair, the step is done once there is data (first steps B1).
    single = n_txns > 0 and n_bank_accounts < 2
    return SetupStatus(steps=(
        SetupStep(
            "statement",
            "Pierwszy wyciąg z banku",
            "Plik CSV (mBank, Pekao, Erste) albo Open Banking.",
            done=n_txns > 0,
            actions=(
                SetupAction("cli", "Kopiuj polecenie", f"{cli} import-csv WYCIAG.csv"),
                SetupAction("cli", "Open Banking", f'{cli} eb login "mBank"'),
            ),
        ),
        SetupStep(
            "categories",
            "Kategorie wydatków",
            "W zakładce Wydatki; reguła zapamięta sprzedawcę.",
            done=n_txns > 0 and (n_manual > 0 or n_uncategorized == 0),
            actions=(SetupAction("tab", "Wydatki", "expenses"),),
        ),
        SetupStep(
            "transfers",
            "Przelewy między kontami",
            "Jedno konto bankowe: nic do dopasowania."
            if single
            else "Po IBAN między Twoimi kontami; nie liczą się jako wydatki.",
            done=n_txns > 0 and (n_transfers > 0 or n_bank_accounts < 2),
            actions=(SetupAction("cli", "Kopiuj polecenie", f"{cli} match-transfers"),),
        ),
    ))
