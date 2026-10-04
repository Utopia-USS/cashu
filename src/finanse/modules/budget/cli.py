"""Budget CLI commands: statement import, categorization, cash pool, Open Banking."""

from __future__ import annotations

import functools
from decimal import Decimal
from pathlib import Path

import typer
from rich.table import Table
from sqlmodel import select

from finanse.config import settings
from finanse.core import cliutil
from finanse.core.db import get_session, init_db
from finanse.core.models import AccountType, Bank

from .models import Transaction
from .service import import_csv

eb_app = typer.Typer(help="Enable Banking (Open Banking) commands.")


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
            cliutil.console.print(f"[red]Enable Banking error:[/] {e}")
            raise typer.Exit(1) from None

    return wrapper


def _report_sync(results) -> None:
    from .ingestion.enable_banking import sync_session

    for r in results:
        cliutil.console.print(
            f"  {r.account.bank.value} '{r.account.name}': "
            f"+{r.batch.num_inserted} ({r.batch.num_duplicates} dup)"
        )
    for err in getattr(sync_session, "last_errors", []):
        cliutil.console.print(f"[yellow]  account skipped (transient? e.g. rate limit) — {err}[/]")


def _save_session_id(session_id: str | None, bank, results) -> None:
    from .ingestion.enable_banking.state import save_session

    key = bank.value if bank else (results[0].account.bank.value if results else None)
    if key and session_id:
        save_session(key, session_id)



# --------------------------------------------------------------------------- #
# Statements, categorization, cash
# --------------------------------------------------------------------------- #

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
        cliutil.console.print(
            f"[green]{path.name}[/] -> {account.bank.value} '{account.name}': "
            f"seen {batch.num_seen}, inserted {batch.num_inserted}, "
            f"duplicates {batch.num_duplicates}"
        )


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
        cliutil.console.print(f"[yellow]No .csv files in {directory}[/]")
        raise typer.Exit()

    bank_by_name = {b.value: b for b in Bank}
    total_inserted = 0
    with get_session() as s:
        for path in files:
            hint = bank or bank_by_name.get(path.parent.name.lower())
            try:
                account, batch = import_csv(s, path, bank=hint)
                total_inserted += batch.num_inserted
                cliutil.console.print(
                    f"[green]{path.name}[/] -> {account.bank.value} '{account.name}' "
                    f"[{account.currency}]: +{batch.num_inserted} ({batch.num_duplicates} dup)"
                )
            except Exception as e:  # keep going on the rest
                cliutil.console.print(f"[red]{path.name}: {e}[/]")
        from .service import categorize_all

        categorize_all(s)  # deterministic categorization (run `categorize --llm` for the tail)
    cliutil.console.print(f"[bold]Inserted {total_inserted} new transaction(s).[/] (categorized)")


def match_transfers_cmd(
    reset: bool = typer.Option(False, help="Clear existing groupings first."),
    max_days: int = typer.Option(3, help="Max day gap between the two legs."),
) -> None:
    """Cross-reference internal transfers between your own accounts."""
    from .ingestion.transfers import match_internal_transfers, reset_transfer_matches

    with get_session() as s:
        if reset:
            cleared = reset_transfer_matches(s)
            cliutil.console.print(f"Cleared {cleared} previously-grouped transactions.")
        pairs = match_internal_transfers(s, max_days=max_days)
    cliutil.console.print(f"[green]Matched {pairs} internal-transfer pair(s).[/]")


def categorize_cmd(
    llm: bool = typer.Option(False, "--llm", help="Use Claude for unknown merchants (opt-in)."),
) -> None:
    """Categorize all transactions (deterministic rules; --llm for the unknown tail)."""
    from .service import categorize_all

    init_db()
    with get_session() as s:
        res = categorize_all(s, use_llm=llm)
    cliutil.console.print(f"[green]Categorized {res['total']} transactions.[/]")
    if llm:
        if res.get("llm_error"):
            cliutil.console.print(f"[yellow]LLM skipped: {res['llm_error']}[/]")
        else:
            cliutil.console.print(
                f"  LLM: +{res['llm_classified']} rules "
                f"({res['unknown_merchants']} unknown expense merchants)"
            )


def cash_cmd() -> None:
    """Show the physical-cash pool (withdrawals in, manual expenses out)."""
    from .cash import get_cash_account

    with get_session() as s:
        acc = get_cash_account(s, create=False)
        if acc is None:
            cliutil.console.print("[yellow]No cash pool.[/] Mark a withdrawal as "
                          "'Wypłata gotówki' or add an expense: finanse cash-add …")
            return
        txns = sorted(
            s.exec(select(Transaction).where(Transaction.account_id == acc.id)).all(),
            key=lambda t: (t.booking_date, t.id or 0), reverse=True,
        )
        balance = sum((t.amount for t in txns), Decimal("0"))
    cliutil.console.print(f"[bold]Cash:[/] {cliutil.fmt(balance, acc.currency)}")
    table = Table(title="Cash movements")
    for col in ("date", "title", "category", "amount"):
        table.add_column(col)
    for t in txns[:40]:
        table.add_row(
            t.booking_date.isoformat(),
            t.reference or t.description or "—",
            t.category or "—",
            cliutil.fmt(t.amount, t.currency),
        )
    cliutil.console.print(table)


def cash_add_cmd(
    amount: float = typer.Argument(..., help="Expense amount (positive)."),
    title: str = typer.Argument(..., help="Title, e.g. 'Lunch'."),
    category: str = typer.Argument(..., help="Category key, e.g. 'dining'."),
    date: str = typer.Option(None, "--date", help="YYYY-MM-DD (default: today)."),
) -> None:
    """Log a manual cash expense (draws down the cash pool)."""
    from datetime import date as _date

    from .cash import add_cash_expense
    from .categorize import taxonomy

    if category not in taxonomy.CATEGORY_KEYS:
        raise typer.BadParameter(f"Unknown category. Allowed: {', '.join(taxonomy.CATEGORY_KEYS)}")
    init_db()
    on_date = _date.fromisoformat(date) if date else None
    with get_session() as s:
        add_cash_expense(s, amount=amount, title=title, category=category, on_date=on_date)
    cliutil.console.print(f"[green]Cash expense[/] −{amount:.2f}: {title} ({category})")


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
            cliutil.console.print(f"  {tag}: … {done}/{total} groups", end="\r")
        return _p

    with get_session() as s:
        if recent_days is not None:
            cutoff = _date.today() - timedelta(days=recent_days)
            cliutil.console.print(f"[bold]Last {recent_days} days[/] (from {cutoff}) → {recent_model}")
            r1 = reclassify_all(
                s, model=recent_model, batch_size=batch_size, limit=limit,
                date_from=cutoff, progress=_mk_progress(recent_model),
            )
            cliutil.console.print(f"\n[bold]Older[/] (up to {cutoff - timedelta(days=1)}) → {old_model}")
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
    cliutil.console.print()
    cliutil.console.print(
        f"[green]Reclassification done[/] (model {res['model']}): "
        f"{res['targets']} transactions in {res['groups']} groups, "
        f"LLM {res['classified_txns']}, fallback {res['fallback_txns']}."
    )
    dist = Table(title="Category distribution")
    dist.add_column("category")
    dist.add_column("count", justify="right")
    for k, v in list(res["distribution"].items())[:25]:
        dist.add_row(k, str(v))
    cliutil.console.print(dist)


def set_category_cmd(merchant: str, category: str) -> None:
    """Pin a merchant to a category (manual, wins over rules/AI) and re-apply."""
    from .categorize import taxonomy
    from .ingestion.normalize import normalize_text
    from .service import recategorize_merchant

    if category not in taxonomy.CATEGORY_KEYS:
        raise typer.BadParameter(f"Unknown category. Allowed: {', '.join(taxonomy.CATEGORY_KEYS)}")
    with get_session() as s:
        n = recategorize_merchant(s, normalize_text(merchant), category)
    cliutil.console.print(f"[green]{normalize_text(merchant)} → {category}[/] ({n} transactions)")



# --------------------------------------------------------------------------- #
# Enable Banking
# --------------------------------------------------------------------------- #

@eb_app.command("check")
@eb_guard
def eb_check() -> None:
    """Verify Enable Banking credentials by fetching application info."""
    if not settings.eb_configured:
        cliutil.console.print(
            "[red]Not configured.[/] Set FINANSE_EB_APP_ID and place the private "
            f"key at {settings.eb_key_file} (see .env.example)."
        )
        raise typer.Exit(1)
    app_info = _client().get_application()
    cliutil.console.print(app_info)


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
    cliutil.console.print(table)


@eb_app.command("auth")
@eb_guard
def eb_auth(
    aspsp: str = typer.Argument(..., help="Exact ASPSP name from `eb banks`."),
    country: str = typer.Option(None),
    days: int = typer.Option(90),
) -> None:
    """Start bank authorization; open the printed URL and complete SCA login."""
    res = _client().start_authorization(aspsp, country or settings.eb_country, valid_days=days)
    cliutil.console.print("[bold]Open this URL, log in to your bank, then copy the `code` "
                  "query param from the redirect URL:[/]")
    cliutil.console.print(res.get("url", res))


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
        cliutil.console.print(f"[red]No authorization URL in response:[/] {res}")
        raise typer.Exit(1)

    cliutil.console.print("Opening your browser for the bank login (SCA)…")
    cliutil.console.print(f"If it doesn't open, paste this URL manually:\n[blue]{url}[/]")
    webbrowser.open(url)
    cliutil.console.print(f"Waiting for redirect to {settings.eb_redirect_url} …")

    code = wait_for_authorization_code(settings.eb_redirect_url)
    if not code:
        cliutil.console.print(
            "[red]Timed out.[/] You can finish manually: copy the `code` from the "
            "redirect URL and run `finanse eb connect <code>`."
        )
        raise typer.Exit(1)

    eb_session = client.create_session(code)
    session_id = eb_session.get("session_id")
    cliutil.console.print(f"[green]Session created:[/] {session_id}")
    with get_session() as s:
        results = sync_session(s, client, session_id, bank=bank, days=days)
        _report_sync(results)
    _save_session_id(session_id, bank, results)
    cliutil.console.print("[dim]Session saved — re-sync later with `finanse eb resync`. "
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
    cliutil.console.print(f"[green]Session created:[/] {session_id}")
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
    cliutil.console.print(f"[green]Updated {n} transactions[/] (titles/notes from Open Banking).")


@eb_app.command("resync")
@eb_guard
def eb_resync(days: int = typer.Option(90)) -> None:
    """Re-sync every saved session (from previous `eb login`/`connect`)."""
    from .ingestion.enable_banking import sync_session
    from .ingestion.enable_banking.client import EnableBankingError
    from .ingestion.enable_banking.state import load_sessions

    sessions = load_sessions()
    if not sessions:
        cliutil.console.print("[yellow]No saved sessions. Run `finanse eb login` first.[/]")
        raise typer.Exit(1)

    init_db()
    client = _client()
    with get_session() as s:
        for bank_val, sid in sessions.items():
            cliutil.console.print(f"[bold]{bank_val}[/] (session {sid[:8]}…)")
            try:
                _report_sync(sync_session(s, client, sid, bank=Bank(bank_val), days=days))
            except EnableBankingError as e:  # expired/rate-limited session — try the rest
                cliutil.console.print(f"[yellow]  {bank_val}: {e}[/]")


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("import-csv")(import_csv_cmd)
    app.command("import-dir")(import_dir_cmd)
    app.command("match-transfers")(match_transfers_cmd)
    app.command("categorize")(categorize_cmd)
    app.command("cash")(cash_cmd)
    app.command("cash-add")(cash_add_cmd)
    app.command("reclassify")(reclassify_cmd)
    app.command("set-category")(set_category_cmd)
    app.add_typer(eb_app, name="eb")
