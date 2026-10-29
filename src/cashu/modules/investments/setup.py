"""Investments' blank-page steps (``ModuleSpec.setup_status``). Copy is UI data in the current
language (``core.i18n``)."""

from __future__ import annotations

from sqlmodel import Session, select

from cashu.core.i18n import tr
from cashu.core.models import Account, Profile
from cashu.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix

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
    copy = tr(pl="Kopiuj polecenie", en="Copy command")
    return SetupStatus(
        steps=(
            SetupStep(
                "broker_account",
                tr(pl="Dodaj rachunek maklerski", en="Add a brokerage account"),
                tr(
                    pl="Broker + opakowanie (zwykłe, IKE, IKZE).",
                    en="Broker + wrapper (regular, IKE, IKZE).",
                ),
                done=has_account,
                actions=(
                    SetupAction(
                        "cli",
                        copy,
                        f'{cli} invest accounts add "XTB IKE" --broker xtb --wrapper ike',
                    ),
                ),
            ),
            SetupStep(
                "strategy",
                tr(pl="Zapisz strategię", en="Save the strategy"),
                tr(
                    pl="strategy.yaml i strategy.md; wywiad w Claude Code albo szablon.",
                    en="strategy.yaml and strategy.md; an interview in Claude Code or a template.",
                ),
                done=has_strategy,
                actions=(
                    SetupAction(
                        "cli",
                        tr(pl="Utwórz z szablonu", en="Create from a template"),
                        f"{cli} invest strategy init",
                    ),
                ),
            ),
            SetupStep(
                "first_import",
                tr(pl="Pierwsza wpłata lub import", en="First contribution or import"),
                tr(
                    pl="Plik od brokera (format cashU albo CSV).",
                    en="A file from your broker (cashU format or CSV).",
                ),
                done=has_txn,
                actions=(
                    SetupAction(
                        "cli",
                        copy,
                        tr(
                            pl=f"{cli} invest import PLIK.csv --account ID_RACHUNKU",
                            en=f"{cli} invest import FILE.csv --account ACCOUNT_ID",
                        ),
                    ),
                ),
            ),
            SetupStep(
                "first_run",
                tr(pl="Pierwszy przebieg reguł", en="First rules run"),
                tr(pl="Wycena, alokacja, sygnały.", en="Valuation, allocation, signals."),
                done=has_run,
                actions=(SetupAction("cli", copy, f"{cli} invest run"),),
            ),
        )
    )
