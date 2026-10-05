"""Investments' blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlmodel import Session, select

from finanse.core.models import Account, Profile
from finanse.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix

from .models import InvRuleRun, InvTransaction
from .service import files
from .store.transactions import BROKERAGE


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    profile = session.get(Profile, profile_id)
    accounts = select(Account.id).where(Account.profile_id == profile_id, Account.type == BROKERAGE)
    has_account = session.exec(accounts.limit(1)).first() is not None
    has_strategy = profile is not None and files.strategy_yaml_path(profile.slug).is_file()
    has_txn = (
        session.exec(
            select(InvTransaction.id).where(InvTransaction.account_id.in_(accounts)).limit(1)
        ).first()
        is not None
    )
    has_run = (
        session.exec(
            select(InvRuleRun.id)
            .where(InvRuleRun.profile_id == profile_id, InvRuleRun.status.in_(("ok", "partial")))
            .limit(1)
        ).first()
        is not None
    )
    return SetupStatus(
        steps=(
            SetupStep(
                "broker_account",
                "Dodaj rachunek maklerski",
                "Broker + opakowanie (zwykłe, IKE, IKZE).",
                done=has_account,
                actions=(
                    SetupAction(
                        "cli",
                        "Kopiuj polecenie",
                        f'{cli} invest accounts add "XTB IKE" --broker xtb --wrapper ike',
                    ),
                ),
            ),
            SetupStep(
                "strategy",
                "Zapisz strategię",
                "strategy.yaml i strategy.md; wywiad w Claude Code albo szablon.",
                done=has_strategy,
                actions=(SetupAction("cli", "Utwórz z szablonu", f"{cli} invest strategy init"),),
            ),
            SetupStep(
                "first_import",
                "Pierwsza wpłata lub import",
                "Plik od brokera (format finanse albo CSV).",
                done=has_txn,
                actions=(
                    SetupAction(
                        "cli",
                        "Kopiuj polecenie",
                        f"{cli} invest import PLIK.csv --account ID_RACHUNKU",
                    ),
                ),
            ),
            SetupStep(
                "first_run",
                "Pierwszy przebieg reguł",
                "Wycena, alokacja, sygnały.",
                done=has_run,
                actions=(SetupAction("cli", "Kopiuj polecenie", f"{cli} invest run"),),
            ),
        )
    )
