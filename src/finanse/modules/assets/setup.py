"""Assets' blank-page steps (``ModuleSpec.setup_status``). Copy is Polish UI data."""

from __future__ import annotations

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core.models import Account, AccountType
from finanse.core.modules import SetupAction, SetupStatus, SetupStep, cli_prefix

from .models import Depreciation

POSITION_TYPES = (AccountType.PROPERTY, AccountType.VEHICLE, AccountType.INVESTMENT, AccountType.OTHER)


def setup_status(session: Session, profile_id: int) -> SetupStatus:
    cli = cli_prefix(session, profile_id)
    positions = session.exec(
        select(Account).where(
            Account.profile_id == profile_id,
            Account.type.in_(POSITION_TYPES),
            Account.removed_at.is_(None),  # a removed position does not count (F7 MB2)
        )
    ).all()
    vehicles = [a.id for a in positions if a.type == AccountType.VEHICLE]
    n_depreciating = int(session.exec(
        select(func.count(Depreciation.id)).where(Depreciation.account_id.in_(vehicles))
    ).one() or 0) if vehicles else 0
    return SetupStatus(steps=(
        SetupStep(
            "position",
            "Dodaj pozycję",
            "Nazwa, wartość, waluta.",
            done=bool(positions),
            actions=(SetupAction(
                "cli", "Kopiuj polecenie",
                f'{cli} add-position "Mieszkanie" --type property --value 500000',
            ),),
        ),
        SetupStep(
            "vehicle",
            "Krzywa utraty wartości auta",
            "Cena zakupu, data, roczny spadek.",
            done=bool(positions) and (not vehicles or n_depreciating == len(vehicles)),
            actions=(SetupAction(
                "cli", "Kopiuj polecenie",
                f'{cli} set-vehicle "Auto" 80000 2025-05-01 --rate 15',
            ),),
        ),
    ))
