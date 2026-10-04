"""Budget's blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core.models import Account, Bank
from finanse.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix

from .models import CategoryRule, Transaction


def _count(session: Session, stmt) -> int:
    return int(session.exec(stmt).one() or 0)


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    bank_ids = select(Account.id).where(
        Account.profile_id == profile_id, Account.bank != Bank.MANUAL
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

    return SetupStatus(steps=(
        SetupStep(
            "bank_account",
            "Dodaj bank i konto",
            "Konto pojawia się po pierwszym imporcie wyciągu CSV albo po połączeniu przez "
            "Open Banking. Konto = jeden rachunek w jednym banku.",
            done=n_bank_accounts > 0,
            actions=(SetupAction("cli", "Kopiuj polecenie", f"{cli} import-csv WYCIAG.csv"),),
        ),
        SetupStep(
            "first_import",
            "Wgraj pierwszy CSV lub połącz Open Banking",
            "Eksport CSV z banku (mBank, Erste, Pekao) albo połączenie przez Enable Banking; "
            "kolejne wyciągi nie dublują transakcji.",
            done=n_txns > 0,
            actions=(
                SetupAction("cli", "Import katalogu", f"{cli} import-dir statements/"),
                SetupAction("cli", "Open Banking", f'{cli} eb login "mBank"'),
            ),
        ),
        SetupStep(
            "categories",
            "Sprawdź kategorie (10 najczęstszych sprzedawców)",
            "Popraw kategorię w zakładce Wydatki; reguła zapamięta sprzedawcę dla tego profilu.",
            done=n_txns > 0 and (n_manual > 0 or n_uncategorized == 0),
            actions=(SetupAction("tab", "Wydatki", "expenses"),),
        ),
        SetupStep(
            "transfers",
            "Oznacz przelewy wewnętrzne",
            "Przelewy między własnymi kontami są dopasowywane po IBAN, żeby nie liczyły się "
            "jako wydatki ani przychody.",
            done=n_txns > 0 and (n_transfers > 0 or n_bank_accounts < 2),
            actions=(SetupAction("cli", "Kopiuj polecenie", f"{cli} match-transfers"),),
        ),
    ))
