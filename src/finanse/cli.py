"""Command-line interface for the finance tracker (Phase 1: ingestion)."""

from __future__ import annotations

import enum
import functools
import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table
from sqlmodel import select

from .config import settings
from .core import paths
from .db import get_session, init_db
from .models import Account, AccountType, Bank
from .service import import_csv

app = typer.Typer(add_completion=False, help="Personal finance tracker — bank ingestion & stats.")
eb_app = typer.Typer(help="Enable Banking (Open Banking) commands.")
app.add_typer(eb_app, name="eb")
secrets_app = typer.Typer(help="Secrets in the OS keychain (instead of .env).")
app.add_typer(secrets_app, name="secrets")

console = Console()
err_console = Console(stderr=True)


@app.callback()
def _main(ctx: typer.Context) -> None:
    # Data still in the legacy <repo>/data/ dir: say so on every command.
    notice = paths.legacy_notice()
    if notice and ctx.invoked_subcommand != "migrate-data":
        err_console.print(f"[yellow]Notice:[/] {notice}")


def fmt(amount: Decimal | None, currency: str = "PLN") -> str:
    if amount is None:
        return "—"
    q = Decimal(amount).quantize(Decimal("0.01"))
    s = f"{q:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} {currency}"


def _client():
    from .ingestion.enable_banking import EnableBankingClient

    return EnableBankingClient(
        settings.eb_app_id or "",
        settings.eb_key_file,
        base_url=settings.eb_base_url,
        redirect_url=settings.eb_redirect_url,
    )


def eb_guard(fn):
    """Turn Enable Banking API errors into a clean message instead of a traceback."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        from .ingestion.enable_banking.client import EnableBankingError

        try:
            return fn(*args, **kwargs)
        except EnableBankingError as e:
            console.print(f"[red]Enable Banking error:[/] {e}")
            raise typer.Exit(1) from None

    return wrapper


def _report_sync(results) -> None:
    from .ingestion.enable_banking import sync_session

    for r in results:
        console.print(
            f"  {r.account.bank.value} '{r.account.name}': "
            f"+{r.batch.num_inserted} ({r.batch.num_duplicates} dup)"
        )
    for err in getattr(sync_session, "last_errors", []):
        console.print(f"[yellow]  account skipped (transient? e.g. rate limit) — {err}[/]")


def _save_session_id(session_id: str | None, bank, results) -> None:
    from .ingestion.enable_banking.state import save_session

    key = bank.value if bank else (results[0].account.bank.value if results else None)
    if key and session_id:
        save_session(key, session_id)


# --------------------------------------------------------------------------- #
# Setup / inspection
# --------------------------------------------------------------------------- #

@app.command("init-db")
def init_db_cmd() -> None:
    """Create the SQLite database and tables."""
    from . import db

    init_db()
    console.print(f"[green]Database ready[/] at {db.engine.url.render_as_string(hide_password=True)}")


@app.command("serve")
def serve_cmd(
    host: Annotated[
        str | None,
        typer.Option(envvar="FINANSE_HOST", show_default="127.0.0.1", help="Interface to bind."),
    ] = None,
    port: Annotated[
        int | None, typer.Option(envvar="FINANSE_PORT", show_default="8500", help="Port.")
    ] = None,
    reload: Annotated[bool, typer.Option(help="Auto-reload on code changes (dev).")] = False,
) -> None:
    """Launch the web dashboard (net worth, cashflow, subscriptions).

    Loopback only; every API call needs the per-launch token, which the served
    page carries and which is written to <data dir>/api-token for local tools."""
    import uvicorn

    from .core import security

    host = host or settings.host
    port = port or settings.port
    init_db()
    cfg = security.configure(port=port)
    token_file = security.write_token_file(cfg.token)
    if host not in security.LOOPBACK_HOSTS:
        console.print(
            f"[yellow]Binding to {host}:[/] the API only answers requests addressed to "
            "127.0.0.1/localhost, so other machines cannot use the dashboard."
        )
    if reload:  # the reloader re-imports the app in a worker process
        os.environ[security.TOKEN_ENV] = cfg.token
        os.environ["FINANSE_PORT"] = str(port)
    console.print(f"[green]Dashboard:[/] http://127.0.0.1:{port}")
    console.print(f"[dim]Data dir: {paths.data_dir()} (API token: {token_file.name})[/]")
    try:
        uvicorn.run("finanse.api.app:app", host=host, port=port, reload=reload)
    finally:
        security.remove_token_file(cfg.token, token_file)


@app.command("migrate-data")
def migrate_data_cmd(
    force: Annotated[
        bool,
        typer.Option(help="Replace a database already in the data dir (backed up first)."),
    ] = False,
) -> None:
    """Copy legacy data from the repo's data/ dir into the per-user data dir.

    Copies the database (with a timestamped backup), Open Banking sessions and
    private key. The originals stay untouched; delete them after checking."""
    from .core import legacy

    try:
        result = legacy.migrate_legacy_data(force=force)
    except legacy.MigrationError as e:
        console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    console.print(f"[green]Migrated[/] {result.source} -> {result.database}")
    console.print(f"  backup: {result.backup}")
    if result.replaced_backup:
        console.print(f"  previous data-dir database backed up to {result.replaced_backup}")
    console.print(f"  tables: {', '.join(f'{k}={v}' for k, v in sorted(result.tables.items()))}")
    for p in result.copied:
        console.print(f"  copied: {p}")
    for s in result.skipped:
        console.print(f"  [yellow]skipped:[/] {s}")
    console.print(
        f"The files in {result.source.parent} were not changed; delete them once the "
        "dashboard looks right. Settings pointing at the old defaults (data/finanse.db, "
        "data/enablebanking_private.pem) are ignored from now on. Restart `finanse serve` "
        "if it is running."
    )


@app.command("accounts")
def accounts_cmd() -> None:
    """List known accounts."""
    with get_session() as s:
        rows = s.exec(select(Account)).all()
    table = Table(title="Accounts")
    for col in ("id", "bank", "name", "iban", "type", "currency", "active"):
        table.add_column(col)
    for a in rows:
        table.add_row(
            str(a.id), a.bank.value, a.name, a.iban or "—",
            a.type.value, a.currency, "yes" if a.active else "no",
        )
    console.print(table)


@app.command("set-account-type")
def set_account_type(account_id: int, account_type: AccountType) -> None:
    """Set an account's type (checking/savings/credit/investment/...)."""
    with get_session() as s:
        acc = s.get(Account, account_id)
        if not acc:
            raise typer.BadParameter(f"No account with id {account_id}")
        acc.type = account_type
        s.add(acc)
    console.print(f"[green]Account {account_id} -> {account_type.value}[/]")


@app.command("set-account-name")
def set_account_name(account_id: int, name: str) -> None:
    """Give an account a human-friendly name."""
    with get_session() as s:
        acc = s.get(Account, account_id)
        if not acc:
            raise typer.BadParameter(f"No account with id {account_id}")
        acc.name = name
        s.add(acc)
    console.print(f"[green]Account {account_id} -> '{name}'[/]")


@app.command("set-loan")
def set_loan_cmd(
    account_id: int,
    principal: float,
    rate: float,
    years: int = typer.Option(30, help="Loan term in years."),
    start: str = typer.Option(None, "--start", help="First installment YYYY-MM-DD (default: 1st of this month)."),
    origination: str = typer.Option(None, "--origination", help="Disbursement YYYY-MM-DD (debt exists from here)."),
) -> None:
    """Set amortization terms for a loan account (drives the payoff simulator)."""
    from datetime import date as _date

    from .service import set_loan

    sd = _date.fromisoformat(start) if start else _date.today().replace(day=1)
    od = _date.fromisoformat(origination) if origination else None
    init_db()
    with get_session() as s:
        set_loan(s, account_id, principal, rate, years * 12, sd, origination_date=od)
    console.print(
        f"[green]Loan[/] account {account_id}: {principal:,.0f} @ {rate}% / {years} yr, "
        f"1st installment {sd}" + (f", origination {od}" if od else "")
    )


@app.command("add-position")
def add_position_cmd(
    name: str = typer.Argument(..., help="e.g. 'Apartment' or 'Mortgage'."),
    type: AccountType = typer.Option(..., help="property | mortgage | loan | investment | cash | ..."),
    value: float = typer.Option(..., help="Current value / outstanding balance."),
    currency: str = typer.Option("PLN"),
) -> None:
    """Add a manually-tracked asset or liability (property, mortgage, loan, ...)."""
    from decimal import Decimal

    from .service import add_manual_position

    init_db()
    with get_session() as s:
        acc = add_manual_position(s, name=name, type=type, value=value, currency=currency)
        console.print(
            f"[green]{acc.type.value}[/] '{acc.name}' = "
            f"{fmt(Decimal(str(value)), currency)} (account id {acc.id})"
        )


@app.command("set-vehicle")
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
        from .depreciation import value_of
        from .models import Depreciation
        from sqlmodel import select as _select
        dep = s.exec(_select(Depreciation).where(Depreciation.account_id == acc.id)).first()
        now_val = value_of(dep, _date.today())
    console.print(
        f"[green]Vehicle[/] '{acc.name}': bought {pd} for {fmt(Decimal(str(price)), currency)}, "
        f"depreciation {rate}%/yr" + (f", floor {fmt(Decimal(str(floor)), currency)}" if floor else "")
        + f" → value today ≈ {fmt(now_val, currency)}"
    )


@app.command("set-balance")
def set_balance_cmd(
    account_id: int,
    value: float,
    date: str = typer.Option(None, "--date", help="YYYY-MM-DD (default: today)."),
) -> None:
    """Record a balance snapshot (update a mortgage, revalue a property, ...)."""
    from datetime import date as _date
    from decimal import Decimal

    from .service import set_balance

    on_date = _date.fromisoformat(date) if date else None
    with get_session() as s:
        acc = set_balance(s, account_id, value, on_date=on_date)
        console.print(f"[green]{acc.name}[/] -> {fmt(Decimal(str(value)), acc.currency)}")


# --------------------------------------------------------------------------- #
# CSV import
# --------------------------------------------------------------------------- #

@app.command("import-csv")
def import_csv_cmd(
    path: Path = typer.Argument(..., exists=True, readable=True),
    bank: Bank | None = typer.Option(None, help="Force bank (skip auto-detect)."),
    account_type: AccountType = typer.Option(AccountType.CHECKING),
    name: str | None = typer.Option(None, help="Override account name."),
) -> None:
    """Import a single CSV/statement export."""
    init_db()
    with get_session() as s:
        account, batch = import_csv(
            s, path, bank=bank, account_type=account_type, account_name=name
        )
        console.print(
            f"[green]{path.name}[/] -> {account.bank.value} '{account.name}': "
            f"seen {batch.num_seen}, inserted {batch.num_inserted}, "
            f"duplicates {batch.num_duplicates}"
        )


@app.command("import-dir")
def import_dir_cmd(
    directory: Path = typer.Argument(Path("data/incoming"), exists=True),
    bank: Bank | None = typer.Option(None, help="Force bank for all files."),
    recursive: bool = typer.Option(True, help="Recurse into subdirectories."),
) -> None:
    """Import every .csv under a directory.

    Bank is taken from --bank, else from a `mbank`/`erste` subdirectory name,
    else auto-detected from file content.
    """
    init_db()
    files = sorted(directory.rglob("*.csv") if recursive else directory.glob("*.csv"))
    if not files:
        console.print(f"[yellow]No .csv files in {directory}[/]")
        raise typer.Exit()

    bank_by_name = {b.value: b for b in Bank}
    total_inserted = 0
    with get_session() as s:
        for path in files:
            hint = bank or bank_by_name.get(path.parent.name.lower())
            try:
                account, batch = import_csv(s, path, bank=hint)
                total_inserted += batch.num_inserted
                console.print(
                    f"[green]{path.name}[/] -> {account.bank.value} '{account.name}' "
                    f"[{account.currency}]: +{batch.num_inserted} ({batch.num_duplicates} dup)"
                )
            except Exception as e:  # keep going on the rest
                console.print(f"[red]{path.name}: {e}[/]")
        from .service import categorize_all

        categorize_all(s)  # deterministic categorization (run `categorize --llm` for the tail)
    console.print(f"[bold]Inserted {total_inserted} new transaction(s).[/] (categorized)")


@app.command("match-transfers")
def match_transfers_cmd(
    reset: bool = typer.Option(False, help="Clear existing groupings first."),
    max_days: int = typer.Option(3, help="Max day gap between the two legs."),
) -> None:
    """Cross-reference internal transfers between your own accounts."""
    from .ingestion.transfers import match_internal_transfers, reset_transfer_matches

    with get_session() as s:
        if reset:
            cleared = reset_transfer_matches(s)
            console.print(f"Cleared {cleared} previously-grouped transactions.")
        pairs = match_internal_transfers(s, max_days=max_days)
    console.print(f"[green]Matched {pairs} internal-transfer pair(s).[/]")


@app.command("categorize")
def categorize_cmd(
    llm: bool = typer.Option(False, "--llm", help="Use Claude for unknown merchants (opt-in)."),
) -> None:
    """Categorize all transactions (deterministic rules; --llm for the unknown tail)."""
    from .service import categorize_all

    init_db()
    with get_session() as s:
        res = categorize_all(s, use_llm=llm)
    console.print(f"[green]Categorized {res['total']} transactions.[/]")
    if llm:
        if res.get("llm_error"):
            console.print(f"[yellow]LLM skipped: {res['llm_error']}[/]")
        else:
            console.print(
                f"  LLM: +{res['llm_classified']} rules "
                f"({res['unknown_merchants']} unknown expense merchants)"
            )


@app.command("cash")
def cash_cmd() -> None:
    """Show the physical-cash pool (withdrawals in, manual expenses out)."""
    from decimal import Decimal

    from .models import Transaction
    from .service import get_cash_account

    with get_session() as s:
        acc = get_cash_account(s, create=False)
        if acc is None:
            console.print("[yellow]No cash pool.[/] Mark a withdrawal as "
                          "'Wypłata gotówki' or add an expense: finanse cash-add …")
            return
        txns = sorted(
            s.exec(select(Transaction).where(Transaction.account_id == acc.id)).all(),
            key=lambda t: (t.booking_date, t.id or 0), reverse=True,
        )
        balance = sum((t.amount for t in txns), Decimal("0"))
    console.print(f"[bold]Cash:[/] {fmt(balance, acc.currency)}")
    table = Table(title="Cash movements")
    for col in ("date", "title", "category", "amount"):
        table.add_column(col)
    for t in txns[:40]:
        table.add_row(
            t.booking_date.isoformat(),
            t.reference or t.description or "—",
            t.category or "—",
            fmt(t.amount, t.currency),
        )
    console.print(table)


@app.command("cash-add")
def cash_add_cmd(
    amount: float = typer.Argument(..., help="Expense amount (positive)."),
    title: str = typer.Argument(..., help="Title, e.g. 'Lunch'."),
    category: str = typer.Argument(..., help="Category key, e.g. 'dining'."),
    date: str = typer.Option(None, "--date", help="YYYY-MM-DD (default: today)."),
) -> None:
    """Log a manual cash expense (draws down the cash pool)."""
    from datetime import date as _date

    from .categorize import taxonomy
    from .service import add_cash_expense

    if category not in taxonomy.CATEGORY_KEYS:
        raise typer.BadParameter(f"Unknown category. Allowed: {', '.join(taxonomy.CATEGORY_KEYS)}")
    init_db()
    on_date = _date.fromisoformat(date) if date else None
    with get_session() as s:
        add_cash_expense(s, amount=amount, title=title, category=category, on_date=on_date)
    console.print(f"[green]Cash expense[/] −{amount:.2f}: {title} ({category})")


@app.command("reclassify")
def reclassify_cmd(
    model: str = typer.Option(None, "--model", help="Ollama model for the whole run (default: from config)."),
    batch_size: int = typer.Option(25, "--batch-size", help="Transactions per LLM call."),
    limit: int = typer.Option(None, "--limit", help="Only the first N signature groups (for testing)."),
    recent_days: int = typer.Option(
        None, "--recent-days",
        help="Split: use --recent-model for txns in the last N days, --old-model for older.",
    ),
    recent_model: str = typer.Option("qwen2.5:7b", "--recent-model", help="Model for recent txns."),
    old_model: str = typer.Option("qwen2.5:3b", "--old-model", help="Model for older txns."),
) -> None:
    """Re-classify ALL income/expense transactions with the local LLM, using full
    transaction data (overwrites everything, incl. manual). Gateways/BLIK are
    resolved by their embedded merchant. Structural transfers & cash are preserved.

    With --recent-days, recent transactions get the stronger --recent-model and the
    older tail gets the faster --old-model (both applied in one atomic commit)."""
    from collections import defaultdict
    from datetime import date as _date
    from datetime import timedelta

    from .categorize.reclassify import reclassify_all

    init_db()

    def _mk_progress(tag: str):
        def _p(done: int, total: int) -> None:
            console.print(f"  {tag}: … {done}/{total} groups", end="\r")
        return _p

    with get_session() as s:
        if recent_days is not None:
            cutoff = _date.today() - timedelta(days=recent_days)
            console.print(f"[bold]Last {recent_days} days[/] (from {cutoff}) → {recent_model}")
            r1 = reclassify_all(
                s, model=recent_model, batch_size=batch_size, limit=limit,
                date_from=cutoff, progress=_mk_progress(recent_model),
            )
            console.print(f"\n[bold]Older[/] (up to {cutoff - timedelta(days=1)}) → {old_model}")
            r2 = reclassify_all(
                s, model=old_model, batch_size=batch_size, limit=limit,
                date_to=cutoff - timedelta(days=1), progress=_mk_progress(old_model),
            )
            merged = defaultdict(int)
            for d in (r1["distribution"], r2["distribution"]):
                for k, v in d.items():
                    merged[k] += v
            res = {
                "targets": r1["targets"] + r2["targets"],
                "groups": r1["groups"] + r2["groups"],
                "classified_txns": r1["classified_txns"] + r2["classified_txns"],
                "fallback_txns": r1["fallback_txns"] + r2["fallback_txns"],
                "distribution": dict(sorted(merged.items(), key=lambda kv: -kv[1])),
                "model": f"{recent_model} (recent) + {old_model} (older)",
            }
        else:
            res = reclassify_all(
                s, model=model, batch_size=batch_size, limit=limit,
                progress=_mk_progress(model or "llm"),
            )
    console.print()
    console.print(
        f"[green]Reclassification done[/] (model {res['model']}): "
        f"{res['targets']} transactions in {res['groups']} groups, "
        f"LLM {res['classified_txns']}, fallback {res['fallback_txns']}."
    )
    dist = Table(title="Category distribution")
    dist.add_column("category")
    dist.add_column("count", justify="right")
    for k, v in list(res["distribution"].items())[:25]:
        dist.add_row(k, str(v))
    console.print(dist)


@app.command("set-category")
def set_category_cmd(merchant: str, category: str) -> None:
    """Pin a merchant to a category (manual, wins over rules/AI) and re-apply."""
    from .categorize import taxonomy
    from .ingestion.normalize import normalize_text
    from .service import recategorize_merchant

    if category not in taxonomy.CATEGORY_KEYS:
        raise typer.BadParameter(f"Unknown category. Allowed: {', '.join(taxonomy.CATEGORY_KEYS)}")
    with get_session() as s:
        n = recategorize_merchant(s, normalize_text(merchant), category)
    console.print(f"[green]{normalize_text(merchant)} → {category}[/] ({n} transactions)")


# --------------------------------------------------------------------------- #
# Enable Banking
# --------------------------------------------------------------------------- #

@eb_app.command("check")
@eb_guard
def eb_check() -> None:
    """Verify Enable Banking credentials by fetching application info."""
    if not settings.eb_configured:
        console.print(
            "[red]Not configured.[/] Set FINANSE_EB_APP_ID and place the private "
            f"key at {settings.eb_key_file} (see .env.example)."
        )
        raise typer.Exit(1)
    app_info = _client().get_application()
    console.print(app_info)


@eb_app.command("banks")
@eb_guard
def eb_banks(country: str = typer.Option(None)) -> None:
    """List available banks (ASPSPs) for a country."""
    aspsps = _client().get_aspsps(country or settings.eb_country)
    table = Table(title=f"ASPSPs ({country or settings.eb_country})")
    table.add_column("name")
    table.add_column("country")
    for a in aspsps:
        table.add_row(str(a.get("name")), str(a.get("country")))
    console.print(table)


@eb_app.command("auth")
@eb_guard
def eb_auth(
    aspsp: str = typer.Argument(..., help="Exact ASPSP name from `eb banks`."),
    country: str = typer.Option(None),
    days: int = typer.Option(90),
) -> None:
    """Start bank authorization; open the printed URL and complete SCA login."""
    res = _client().start_authorization(aspsp, country or settings.eb_country, valid_days=days)
    console.print("[bold]Open this URL, log in to your bank, then copy the `code` "
                  "query param from the redirect URL:[/]")
    console.print(res.get("url", res))


@eb_app.command("login")
@eb_guard
def eb_login(
    aspsp: str = typer.Argument(..., help="Exact ASPSP name from `eb banks`."),
    bank: Bank | None = typer.Option(None, help="Override bank mapping."),
    country: str = typer.Option(None),
    days: int = typer.Option(90),
) -> None:
    """One-shot: authorize, auto-capture the redirect code, and sync.

    Opens your browser for the bank login (SCA), then listens on the redirect
    URL (FINANSE_EB_REDIRECT_URL — must be whitelisted in the EB control panel)
    to capture the code automatically.
    """
    import webbrowser

    from .ingestion.enable_banking import sync_session
    from .ingestion.enable_banking.callback import wait_for_authorization_code

    init_db()
    client = _client()
    res = client.start_authorization(aspsp, country or settings.eb_country, valid_days=days)
    url = res.get("url")
    if not url:
        console.print(f"[red]No authorization URL in response:[/] {res}")
        raise typer.Exit(1)

    console.print("Opening your browser for the bank login (SCA)…")
    console.print(f"If it doesn't open, paste this URL manually:\n[blue]{url}[/]")
    webbrowser.open(url)
    console.print(f"Waiting for redirect to {settings.eb_redirect_url} …")

    code = wait_for_authorization_code(settings.eb_redirect_url)
    if not code:
        console.print(
            "[red]Timed out.[/] You can finish manually: copy the `code` from the "
            "redirect URL and run `finanse eb connect <code>`."
        )
        raise typer.Exit(1)

    eb_session = client.create_session(code)
    session_id = eb_session.get("session_id")
    console.print(f"[green]Session created:[/] {session_id}")
    with get_session() as s:
        results = sync_session(s, client, session_id, bank=bank, days=days)
        _report_sync(results)
    _save_session_id(session_id, bank, results)
    console.print("[dim]Session saved — re-sync later with `finanse eb resync`. "
                  "After both banks, run `finanse match-transfers`.[/]")


@eb_app.command("connect")
@eb_guard
def eb_connect(
    code: str = typer.Argument(..., help="`code` from the redirect URL after login."),
    bank: Bank | None = typer.Option(None, help="Override bank mapping."),
    days: int = typer.Option(90),
) -> None:
    """Exchange the redirect code for a session and sync it immediately."""
    from .ingestion.enable_banking import sync_session

    init_db()
    client = _client()
    eb_session = client.create_session(code)
    session_id = eb_session.get("session_id")
    console.print(f"[green]Session created:[/] {session_id}")
    with get_session() as s:
        results = sync_session(s, client, session_id, bank=bank, days=days)
        _report_sync(results)
    _save_session_id(session_id, bank, results)


@eb_app.command("sync")
@eb_guard
def eb_sync(
    session_id: str = typer.Argument(...),
    bank: Bank | None = typer.Option(None),
    days: int = typer.Option(90),
) -> None:
    """Re-sync an existing authorized session."""
    from .ingestion.enable_banking import sync_session

    init_db()
    client = _client()
    with get_session() as s:
        _report_sync(sync_session(s, client, session_id, bank=bank, days=days))


@eb_app.command("reprocess")
def eb_reprocess() -> None:
    """Re-derive titles/notes for already-synced Open Banking transactions from raw.

    Fixes rows imported before the field-mapping fix (opaque entry_reference had
    been stored as the transaction title)."""
    from .ingestion.enable_banking.sync import reprocess_open_banking_fields

    init_db()
    with get_session() as s:
        n = reprocess_open_banking_fields(s)
    console.print(f"[green]Updated {n} transactions[/] (titles/notes from Open Banking).")


@eb_app.command("resync")
@eb_guard
def eb_resync(days: int = typer.Option(90)) -> None:
    """Re-sync every saved session (from previous `eb login`/`connect`)."""
    from .ingestion.enable_banking import sync_session
    from .ingestion.enable_banking.client import EnableBankingError
    from .ingestion.enable_banking.state import load_sessions

    sessions = load_sessions()
    if not sessions:
        console.print("[yellow]No saved sessions. Run `finanse eb login` first.[/]")
        raise typer.Exit(1)

    init_db()
    client = _client()
    with get_session() as s:
        for bank_val, sid in sessions.items():
            console.print(f"[bold]{bank_val}[/] (session {sid[:8]}…)")
            try:
                _report_sync(sync_session(s, client, sid, bank=Bank(bank_val), days=days))
            except EnableBankingError as e:  # expired/rate-limited session — try the rest
                console.print(f"[yellow]  {bank_val}: {e}[/]")


# --------------------------------------------------------------------------- #
# Stats
# --------------------------------------------------------------------------- #

@app.command("stats")
def stats_cmd(months: int = typer.Option(12, help="How many recent months to show.")) -> None:
    """Print net worth, monthly cashflow, and recurring-payment candidates."""
    from .analytics import (
        detect_recurring,
        monthly_cashflow,
        net_worth,
        reference_date,
        spending_by_category,
    )

    with get_session() as s:
        totals, lines = net_worth(s)
        cashflow = monthly_cashflow(s)
        recurring = detect_recurring(s)
        ref = reference_date(s)
        cats = spending_by_category(s, year=ref.year, month=ref.month) if ref else []

    nw = Table(title="Net worth")
    for col in ("account", "type", "currency", "as of", "balance"):
        nw.add_column(col)
    for ln in lines:
        nw.add_row(
            f"{ln.account.bank.value} · {ln.account.name}",
            ln.account.type.value,
            ln.account.currency,
            ln.as_of.isoformat() if ln.as_of else "—",
            fmt(ln.contribution, ln.account.currency),
        )
    for currency, total in sorted(totals.items()):
        nw.add_row(f"[bold]TOTAL {currency}[/]", "", "", "", f"[bold]{fmt(total, currency)}[/]")
    console.print(nw)

    cf = Table(title="Monthly cashflow (internal transfers excluded)")
    for col in ("month", "income", "expense", "net"):
        cf.add_column(col)
    for mc in cashflow[-months:]:
        cf.add_row(mc.label, fmt(mc.income), fmt(mc.expense), fmt(mc.net))
    console.print(cf)

    if recurring:
        rt = Table(title="Recurring payment candidates (likely subscriptions)")
        for col in ("payee", "amount", "count", "~every", "last"):
            rt.add_column(col)
        for c in recurring[:25]:
            rt.add_row(
                c.counterparty, fmt(c.typical_amount), str(c.occurrences),
                f"{c.median_gap_days}d", c.last_date.isoformat(),
            )
        console.print(rt)

    if cats:
        ct = Table(title=f"Spending by category — {ref.year}-{ref.month:02d}")
        ct.add_column("category")
        ct.add_column("amount", justify="right")
        for c in cats[:15]:
            ct.add_row(c.label, fmt(c.amount))
        console.print(ct)


# --------------------------------------------------------------------------- #
# Secrets (OS keychain)
# --------------------------------------------------------------------------- #

class SecretName(str, enum.Enum):
    ANTHROPIC = "anthropic"  # Anthropic API key (categorization backend `anthropic`)


@secrets_app.command("set")
def secrets_set_cmd(
    name: SecretName,
    stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the value from standard input (scripts).")
    ] = False,
) -> None:
    """Store a secret in the OS keychain (asked for with hidden input)."""
    from .core import secrets

    value = sys.stdin.readline() if stdin else typer.prompt(f"{name.value}", hide_input=True)
    value = value.strip()
    if not value:
        console.print("[red]Empty value, nothing stored.[/]")
        raise typer.Exit(1)
    try:
        secrets.set_secret(name.value, value)
    except secrets.SecretsError as e:
        console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    console.print(f"[green]Stored[/] {name.value} in the keychain ({secrets.mask(value)}).")


@secrets_app.command("get")
def secrets_get_cmd(
    name: SecretName,
    reveal: Annotated[bool, typer.Option(help="Print the full value.")] = False,
) -> None:
    """Show whether a secret is stored (masked unless --reveal)."""
    from .core import secrets

    value = secrets.get_secret(name.value)
    if value is None:
        hint = ""
        if name is SecretName.ANTHROPIC and settings.resolved_api_key:
            hint = " (an environment variable fallback is set)"
        console.print(f"{name.value}: not in the keychain{hint}")
        raise typer.Exit(1)
    if reveal:
        typer.echo(value)
    else:
        console.print(f"{name.value}: stored in the keychain ({secrets.mask(value)})")


@secrets_app.command("delete")
def secrets_delete_cmd(name: SecretName) -> None:
    """Remove a secret from the OS keychain."""
    from .core import secrets

    try:
        removed = secrets.delete_secret(name.value)
    except secrets.SecretsError as e:
        console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    console.print(f"{name.value}: {'deleted' if removed else 'was not stored'}")


if __name__ == "__main__":
    app()
