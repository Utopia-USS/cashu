"""Assets CLI commands: manual positions and depreciating vehicles."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

import typer
from sqlmodel import select

from finanse.core import account_types, cliutil
from finanse.core.db import get_session, init_db

from . import depreciation
from .models import Depreciation


def add_position_cmd(
    name: Annotated[str, typer.Argument(help="e.g. 'Apartment' or 'Mortgage'.")],
    type: Annotated[
        str, typer.Option(help="property | mortgage | loan | investment | cash | ...")
    ],
    value: Annotated[float, typer.Option(help="Current value / outstanding balance.")],
    currency: Annotated[str, typer.Option()] = "PLN",
) -> None:
    """Add a manually-tracked asset or liability (property, mortgage, loan, ...)."""
    from .service import add_manual_position

    known = account_types.ids()
    if type not in known:
        raise typer.BadParameter(f"Unknown account type '{type}'. Known: {', '.join(known)}.")
    init_db()
    with get_session() as s:
        acc = add_manual_position(
            s, name=name, type=type, value=value, currency=currency,
            profile_id=cliutil.profile(s).id,
        )
        cliutil.console.print(
            f"[green]{acc.type}[/] '{acc.name}' = "
            f"{cliutil.fmt(Decimal(str(value)), currency)} (account id {acc.id})"
        )


def set_vehicle_cmd(
    name: Annotated[str, typer.Argument(help="e.g. 'Hyundai i30'.")],
    price: Annotated[float, typer.Argument(help="Purchase price.")],
    purchase_date: Annotated[str, typer.Argument(help="Purchase date YYYY-MM-DD.")],
    rate: Annotated[
        float, typer.Option("--rate", help="Annual depreciation %% (declining balance).")
    ] = 15.0,
    floor: Annotated[
        float | None, typer.Option("--floor", help="Residual value it won't drop below.")
    ] = None,
    currency: Annotated[str, typer.Option()] = "PLN",
) -> None:
    """Add/update a car (or other depreciating asset) — illiquid, loses value yearly."""
    from datetime import date as _date

    from .service import set_vehicle

    init_db()
    pd = _date.fromisoformat(purchase_date)
    with get_session() as s:
        acc = set_vehicle(
            s, name=name, purchase_price=price, purchase_date=pd,
            annual_rate=rate, floor=floor, currency=currency, profile_id=cliutil.profile(s).id,
        )
        dep = s.exec(select(Depreciation).where(Depreciation.account_id == acc.id)).first()
        now_val = depreciation.value_of(dep, _date.today())  # noqa: DTZ011 - local dates
    floor_txt = f", floor {cliutil.fmt(Decimal(str(floor)), currency)}" if floor else ""
    cliutil.console.print(
        f"[green]Vehicle[/] '{acc.name}': bought {pd} for "
        f"{cliutil.fmt(Decimal(str(price)), currency)}, depreciation {rate}%/yr{floor_txt}"
        f" → value today ≈ {cliutil.fmt(now_val, currency)}"
    )


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("add-position")(add_position_cmd)
    app.command("set-vehicle")(set_vehicle_cmd)
