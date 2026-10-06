"""Alert and watchlist commands of ``cashu invest`` (registered by ``cli.register_module``).

cashu invest alerts list [--status live]
cashu invest alerts kinds
cashu invest alerts add KIND --title T [--instrument VWCE.DE] [--param level=120] [--polarity negative]
                          [--severity action] [--note N] [--cooldown 7] [--expires-in 90] [--scope bucket]
cashu invest alerts mute ID | unmute ID | snooze ID --days 7 | delete ID
cashu invest watchlist list
cashu invest watchlist add SYMBOL_OR_ISIN [--name N] [--currency EUR] [--exchange XETRA] [--note N]
cashu invest watchlist remove ID
"""

from __future__ import annotations

from typing import Annotated

import typer
from rich.table import Table

from cashu.core import cliutil
from cashu.core.db import get_session, init_db


def _value(text: str) -> object:
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            continue
    return text


def _params(pairs: list[str]) -> dict[str, object]:
    out: dict[str, object] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key.strip():
            raise typer.BadParameter(f"--param takes key=value, got {pair!r}")
        out[key.strip()] = _value(value.strip())
    return out


def alerts_list_cmd(
    status: Annotated[
        str, typer.Option(help="all, live, or a comma list (active,triggered,...).")
    ] = "all",
) -> None:
    """The active profile's alerts (triggered first)."""
    from .service import alerts as alert_service
    from .service import views

    init_db()
    try:
        statuses = alert_service.parse_status_filter(status)
    except alert_service.AlertError as e:
        raise typer.BadParameter(str(e)) from None
    with get_session() as s:
        rows = views.alerts_view(s, cliutil.profile(s, create=False), statuses)
    if not rows:
        cliutil.console.print("No alerts.")
        return
    table = Table(title="Alerts")
    for col in ("id", "status", "kind", "on", "polarity", "severity", "title", "source"):
        table.add_column(col)
    for r in rows:
        on = (r["instrument"] or {}).get("label") or r["params"].get("bucket") or r["scope"]
        table.add_row(
            str(r["id"]),
            r["status"],
            r["kind"],
            str(on),
            r["polarity"],
            r["severity"],
            r["title"],
            r["source"],
        )
    cliutil.console.print(table)


def alerts_kinds_cmd() -> None:
    """The alert catalog (kinds, scopes, params)."""
    from .alerts import CATALOG

    for info in CATALOG.values():
        params = ", ".join(
            f"{p.name}{'' if p.required else '?'}"
            + (f"={p.default}" if p.default is not None else "")
            for p in info.params
        )
        cliutil.console.print(
            f"{info.kind.value} [{'/'.join(s.value for s in info.scopes)}] ({params}): {info.doc}",
            markup=False,
            highlight=False,
        )


def alerts_add_cmd(
    kind: Annotated[str, typer.Argument(help="price_above, change_pct, ... (see: alerts kinds).")],
    title: Annotated[str, typer.Option(help="Short name of the alert.")],
    instrument: Annotated[
        str | None,
        typer.Option(help="Instrument id, symbol, ISIN or Yahoo symbol (held or watched)."),
    ] = None,
    param: Annotated[list[str] | None, typer.Option(help="key=value (repeatable).")] = None,
    scope: Annotated[str | None, typer.Option(help="instrument | portfolio | bucket")] = None,
    polarity: Annotated[str, typer.Option(help="positive | negative | neutral")] = "neutral",
    severity: Annotated[str, typer.Option(help="info | action")] = "info",
    note: Annotated[str | None, typer.Option()] = None,
    cooldown: Annotated[int | None, typer.Option(help="Days before it may fire again.")] = None,
    expires_in: Annotated[int | None, typer.Option(help="Expire after this many days.")] = None,
) -> None:
    """Add an alert to the active profile."""
    from .service import alerts as alert_service

    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        try:
            instrument_id = (
                alert_service.find_instrument(s, profile, instrument) if instrument else None
            )
            row = alert_service.create(
                s,
                profile,
                alert_service.AlertInput(
                    kind=kind,
                    title=title,
                    params=_params(param or []),
                    instrument_id=instrument_id,
                    scope=scope,
                    polarity=polarity,
                    severity=severity,
                    note=note,
                    cooldown_days=cooldown,
                    expires_in_days=expires_in,
                ),
                created_by="cli",
            )
        except (alert_service.AlertError, alert_service.AlertNotFound) as e:
            raise typer.BadParameter(str(e)) from None
        alert_id = row.id
    cliutil.console.print(
        f"[green]Alert[/] {alert_id} added ({kind}). It is checked by the daily run."
    )


def _status_change(alert_id: int, changes: dict, done: str) -> None:
    from .service import alerts as alert_service

    init_db()
    with get_session() as s:
        try:
            alert_service.update(s, cliutil.profile(s, create=False), alert_id, changes)
        except alert_service.AlertNotFound as e:
            cliutil.err_console.print(str(e))
            raise typer.Exit(2) from None
        except alert_service.AlertError as e:
            raise typer.BadParameter(str(e)) from None
    cliutil.console.print(f"Alert {alert_id} {done}.")


def alerts_mute_cmd(alert_id: int) -> None:
    """Mute an alert (its open signal closes)."""
    _status_change(alert_id, {"status": "muted"}, "muted")


def alerts_unmute_cmd(alert_id: int) -> None:
    """Re-arm a muted, snoozed or expired alert."""
    _status_change(alert_id, {"status": "active"}, "active again")


def alerts_snooze_cmd(
    alert_id: int, days: Annotated[int, typer.Option(help="Snooze for this many days.")] = 7
) -> None:
    """Snooze an alert (its open signal closes; it is checked again afterwards)."""
    _status_change(alert_id, {"status": "snoozed", "snooze_days": days}, f"snoozed for {days} days")


def alerts_delete_cmd(alert_id: int) -> None:
    """Delete an alert."""
    from .service import alerts as alert_service

    init_db()
    with get_session() as s:
        try:
            alert_service.delete(s, cliutil.profile(s, create=False), alert_id)
        except alert_service.AlertNotFound as e:
            cliutil.err_console.print(str(e))
            raise typer.Exit(2) from None
    cliutil.console.print(f"Alert {alert_id} deleted.")


def watchlist_list_cmd() -> None:
    """Watched instruments of the active profile."""
    from .service import views

    init_db()
    with get_session() as s:
        rows = views.watchlist_view(s, cliutil.profile(s, create=False))
    if not rows:
        cliutil.console.print("The watchlist is empty.")
        return
    table = Table(title="Watchlist")
    for col in ("id", "instrument", "close", "date", "1d", "1m", "held", "alerts", "note"):
        table.add_column(col)
    for r in rows:
        price = r["price"] or {}

        def pct(value: float | None) -> str:
            return "-" if value is None else f"{value * 100:+.1f}%"

        table.add_row(
            str(r["id"]),
            (r["instrument"] or {}).get("label") or "?",
            "-" if not price else f"{price['close']} {price['currency']}",
            price.get("date") or "-",
            pct(price.get("change_1d")),
            pct(price.get("change_1m")),
            "yes" if r["held"] else "",
            str(r["alerts"]["live"]),
            r["note"] or "",
        )
    cliutil.console.print(table)


def watchlist_add_cmd(
    symbol_or_isin: Annotated[str, typer.Argument(help="VWCE.DE, PKN.WA, AAPL.US or an ISIN.")],
    name: Annotated[str | None, typer.Option()] = None,
    currency: Annotated[str | None, typer.Option(help="Needed when the market is unknown.")] = None,
    exchange: Annotated[str | None, typer.Option(help="GPW, XETRA, NASDAQ, LSE, US, ...")] = None,
    note: Annotated[str | None, typer.Option()] = None,
) -> None:
    """Watch an instrument (it joins the daily price refresh)."""
    from .service import watchlist as watch_service

    init_db()
    with get_session() as s:
        try:
            result = watch_service.add(
                s,
                cliutil.profile(s, create=False),
                symbol_or_isin,
                name=name,
                currency=currency,
                exchange=exchange,
                note=note,
            )
        except (watch_service.WatchlistError, watch_service.WatchlistNotFound) as e:
            raise typer.BadParameter(str(e)) from None
        item_id = result.item.id
        warnings = result.warnings
    cliutil.console.print(f"[green]Watching[/] {symbol_or_isin} (item {item_id}).")
    for warning in warnings:
        cliutil.console.print(f"  [yellow]![/] {warning}", markup=True, highlight=False)


def watchlist_remove_cmd(item_id: int) -> None:
    """Stop watching an instrument (its alerts stay)."""
    from .service import watchlist as watch_service

    init_db()
    with get_session() as s:
        try:
            watch_service.remove(s, cliutil.profile(s, create=False), item_id)
        except watch_service.WatchlistNotFound as e:
            cliutil.err_console.print(str(e))
            raise typer.Exit(2) from None
    cliutil.console.print(f"Watchlist item {item_id} removed.")


def register(app: typer.Typer) -> None:
    """``alerts`` and ``watchlist`` sub-apps of ``cashu invest``."""
    alerts_app = typer.Typer(help="Alerts: conditions on prices and weights.", no_args_is_help=True)
    alerts_app.command("list")(alerts_list_cmd)
    alerts_app.command("kinds")(alerts_kinds_cmd)
    alerts_app.command("add")(alerts_add_cmd)
    alerts_app.command("mute")(alerts_mute_cmd)
    alerts_app.command("unmute")(alerts_unmute_cmd)
    alerts_app.command("snooze")(alerts_snooze_cmd)
    alerts_app.command("delete")(alerts_delete_cmd)
    watch_app = typer.Typer(help="Instruments you watch without holding.", no_args_is_help=True)
    watch_app.command("list")(watchlist_list_cmd)
    watch_app.command("add")(watchlist_add_cmd)
    watch_app.command("remove")(watchlist_remove_cmd)
    app.add_typer(alerts_app, name="alerts")
    app.add_typer(watch_app, name="watchlist")
