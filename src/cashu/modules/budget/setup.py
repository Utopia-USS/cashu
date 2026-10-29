"""Budget's blank-page steps (``ModuleSpec.setup_status``). Copy is UI data in the request's
language (``core.i18n.tr``), the CLI placeholders too."""

from __future__ import annotations

from sqlalchemy import func
from sqlmodel import Session, select

from cashu.core.i18n import tr
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
    # Own moves the IBAN matching cannot pair (a card top-up of another own account, a transfer to
    # an own account outside cashU) are handled once they carry the transfer category.
    n_own_moves = _count(session, bank_txns.where(Transaction.category == "transfer"))

    # One bank account: nothing to pair, the step is done once there is data (first steps B1).
    single = n_txns > 0 and n_bank_accounts < 2
    copy = tr(pl="Kopiuj polecenie", en="Copy command")
    return SetupStatus(steps=(
        SetupStep(
            "statement",
            tr(pl="Pierwszy wyciąg z banku", en="First bank statement"),
            tr(
                pl="Plik CSV (mBank, Pekao, Erste) albo Open Banking.",
                en="A CSV file (mBank, Pekao, Erste) or Open Banking.",
            ),
            done=n_txns > 0,
            actions=(
                SetupAction(
                    "cli", copy, f"{cli} import-csv {tr(pl='WYCIAG.csv', en='STATEMENT.csv')}"
                ),
                SetupAction("cli", "Open Banking", f'{cli} eb login "mBank"'),
            ),
        ),
        SetupStep(
            "categories",
            tr(pl="Kategorie wydatków", en="Expense categories"),
            tr(
                pl="W zakładce Wydatki; reguła zapamięta sprzedawcę.",
                en="In the Expenses tab; a rule remembers the merchant.",
            ),
            done=n_txns > 0 and (n_manual > 0 or n_uncategorized == 0),
            actions=(SetupAction("tab", tr(pl="Wydatki", en="Expenses"), "expenses"),),
        ),
        SetupStep(
            "transfers",
            tr(pl="Przelewy między kontami", en="Transfers between accounts"),
            tr(
                pl="Jedno konto bankowe: nic do dopasowania.",
                en="One bank account: nothing to match.",
            )
            if single
            else tr(
                pl="Po IBAN między Twoimi kontami; nie liczą się jako wydatki.",
                en="By IBAN between your accounts; they do not count as expenses.",
            ),
            done=n_txns > 0 and (n_transfers > 0 or n_own_moves > 0 or n_bank_accounts < 2),
            actions=(SetupAction("cli", copy, f"{cli} match-transfers"),),
        ),
    ))
