"""Assets CLI commands: manual positions and depreciating vehicles."""

from __future__ import annotations

from decimal import Decimal

import typer
from sqlmodel import select

from finanse.core import cliutil
from finanse.core.db import get_session, init_db
from finanse.core.models import AccountType

from . import depreciation
from .models import Depreciation


def add_position_cmd(
    name: str = typer.Argument(..., help="e.g. 'Apartment' or 'Mortgage'."),
    type: AccountType = typer.Option(..., help="property | mortgage | loan | investment | cash | ..."),
    value: float = typer.Option(..., help="Current value / outstanding balance."),
    currency: str = typer.Option("PLN"),
) -> None:
    """Add a manually-tracked asset or liability (property, mortgage, loan, ...)."""
    from .service import add_manual_position

    init_db()
    with get_session() as s:
        acc = add_manual_position(s, name=name, type=type, value=value, currency=currency)
        cliutil.console.print(
            f"[green]{acc.type.value}[/] '{acc.name}' = "
            f"{cliutil.fmt(Decimal(str(value)), currency)} (account id {acc.id})"
        )


def set_vehicle_cmd(
    name: str = typer.Argument(..., help="e.g. 'Hyundai i30'."),
    price: float = typer.Argument(..., help="Purchase price."),
    purchase_date: str = typer.Argument(..., help="Purchase date YYYY-MM-DD."),
    rate: float = typer.Option(15.0, "--rate", help="Annual depreciation %% (declining balance)."),
    floor: float = typer.Option(None, "--floor", help="Residual value it won't drop below."),
    currency: str = typer.Option("PLN"),
) -> None:
    """Add/update a car (or other depreciating asset) — illiquid, loses value yearly."""
    from datetime import date as _date

    from .service import set_vehicle

    init_db()
    pd = _date.fromisoformat(purchase_date)
    with get_session() as s:
        acc = set_vehicle(
            s, name=name, purchase_price=price, purchase_date=pd,
            annual_rate=rate, floor=floor, currency=currency,
        )
        dep = s.exec(select(Depreciation).where(Depreciation.account_id == acc.id)).first()
        now_val = depreciation.value_of(dep, _date.today())
    cliutil.console.print(
        f"[green]Vehicle[/] '{acc.name}': bought {pd} for {cliutil.fmt(Decimal(str(price)), currency)}, "
        f"depreciation {rate}%/yr" + (f", floor {cliutil.fmt(Decimal(str(floor)), currency)}" if floor else "")
        + f" → value today ≈ {cliutil.fmt(now_val, currency)}"
    )


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("add-position")(add_position_cmd)
    app.command("set-vehicle")(set_vehicle_cmd)
