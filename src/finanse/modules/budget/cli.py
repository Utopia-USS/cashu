"""Budget CLI commands: statement import, categorization, cash pool, Open Banking.

Every command works on the active profile (root ``--profile`` option or
``FINANSE_PROFILE``, else the default profile; see ``core.cliutil.profile``).
"""

from __future__ import annotations

import functools
from decimal import Decimal
from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table
from sqlmodel import select

from finanse.config import settings
from finanse.core import account_types, cliutil, institutions, profiles
from finanse.core.db import get_session, init_db
from finanse.core.models import AccountType

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


def _check_bank(bank: str | None, *, csv: bool) -> str | None:
    """Validate a ``--bank`` institution id against the registry."""
    if bank is None:
        return None
    known = institutions.csv_ids() if csv else institutions.ids("bank")
    if bank not in known:
        raise typer.BadParameter(f"Unknown bank '{bank}'. Known: {', '.join(known)}.")
    return bank


def _check_account_type(value: str) -> str:
    known = account_types.ids()
    if value not in known:
        raise typer.BadParameter(f"Unknown account type '{value}'. Known: {', '.join(known)}.")
    return value


def _active_profile(*, create: bool = True):
    """(id, slug) of the profile the command works on."""
    with get_session() as s:
        p = cliutil.profile(s, create=create)
        return p.id, p.slug


# --------------------------------------------------------------------------- #
# Statements, categorization, cash
# --------------------------------------------------------------------------- #

def import_csv_cmd(
    path: Annotated[Path, typer.Argument(exists=True, readable=True)],
    bank: Annotated[str | None, typer.Option(help="Force bank (skip auto-detect).")] = None,
    account_type: Annotated[str, typer.Option(help="Account type id.")] = AccountType.CHECKING,
    name: Annotated[str | None, typer.Option(help="Override account name.")] = None,
) -> None:
    """Import a single CSV/statement export."""
    init_db()
    bank = _check_bank(bank, csv=True)
    account_type = _check_account_type(account_type)
    with get_session() as s:
        pid = cliutil.profile(s).id
        account, batch = import_csv(
            s, path, bank=bank, account_type=account_type, account_name=name, profile_id=pid
        )
        cliutil.console.print(
            f"[green]{path.name}[/] -> {account.bank} '{account.name}': "
            f"seen {batch.num_seen}, inserted {batch.num_inserted}, "
            f"duplicates {batch.num_duplicates}"
        )


def import_dir_cmd(
    directory: Annotated[Path, typer.Argument(exists=True)] = Path("data/incoming"),
    bank: Annotated[str | None, typer.Option(help="Force bank for all files.")] = None,
    recursive: Annotated[bool, typer.Option(help="Recurse into subdirectories.")] = True,
) -> None:
    """Import every .csv under a directory.

    Bank is taken from --bank, else from a subdirectory named after the bank
    (`mbank`, `erste`, `pekao`, ...), else auto-detected from file content.
    """
    init_db()
    bank = _check_bank(bank, csv=True)
    files = sorted(directory.rglob("*.csv") if recursive else directory.glob("*.csv"))
    if not files:
        cliutil.console.print(f"[yellow]No .csv files in {directory}[/]")
        raise typer.Exit()

    by_dir_name = set(institutions.csv_ids())
    total_inserted = 0
    with get_session() as s:
        pid = cliutil.profile(s).id
        for path in files:
            dir_name = path.parent.name.lower()
            hint = bank or (dir_name if dir_name in by_dir_name else None)
            try:
                account, batch = import_csv(s, path, bank=hint, profile_id=pid)
                total_inserted += batch.num_inserted
                cliutil.console.print(
                    f"[green]{path.name}[/] -> {account.bank} '{account.name}' "
                    f"[{account.currency}]: +{batch.num_inserted} ({batch.num_duplicates} dup)"
                )
            except Exception as e:  # noqa: BLE001 - keep going on the rest
                cliutil.console.print(f"[red]{path.name}: {e}[/]")
        from .service import categorize_all

        # deterministic categorization (run `categorize --llm` for the tail)
        categorize_all(s, profile_id=pid)
    cliutil.console.print(f"[bold]Inserted {total_inserted} new transaction(s).[/] (categorized)")


def match_transfers_cmd(
    reset: Annotated[bool, typer.Option(help="Clear existing groupings first.")] = False,
    max_days: Annotated[int, typer.Option(help="Max day gap between the two legs.")] = 3,
) -> None:
    """Cross-reference internal transfers between your own accounts."""
    from .ingestion.transfers import match_internal_transfers, reset_transfer_matches

    with get_session() as s:
        pid = cliutil.profile(s).id
        if reset:
            cleared = reset_transfer_matches(s, profile_id=pid)
            cliutil.console.print(f"Cleared {cleared} previously-grouped transactions.")
        pairs = match_internal_transfers(s, max_days=max_days, profile_id=pid)
    cliutil.console.print(f"[green]Matched {pairs} internal-transfer pair(s).[/]")


def categorize_cmd(
    llm: Annotated[
        bool, typer.Option("--llm", help="Use Claude for unknown merchants (opt-in).")
    ] = False,
) -> None:
    """Categorize all transactions (deterministic rules; --llm for the unknown tail)."""
    from .service import categorize_all

    init_db()
    with get_session() as s:
        res = categorize_all(s, use_llm=llm, profile_id=cliutil.profile(s).id)
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
        acc = get_cash_account(s, create=False, profile_id=cliutil.profile(s, create=False).id)
        if acc is None:
            cliutil.console.print(
                "[yellow]No cash pool.[/] Mark a withdrawal as "
                "'Wypłata gotówki' or add an expense: finanse cash-add …"
            )
            return
        txns = sorted(
            s.exec(select(Transaction).where(Transaction.account_id == acc.id)).all(),
            key=lambda t: (t.booking_date, t.id or 0), reverse=True,
        )
        balance = sum((t.amount for t in txns), Decimal(0))
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
    amount: Annotated[float, typer.Argument(help="Expense amount (positive).")],
    title: Annotated[str, typer.Argument(help="Title, e.g. 'Lunch'.")],
    category: Annotated[str, typer.Argument(help="Category key, e.g. 'dining'.")],
    date: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
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
        add_cash_expense(
            s, amount=amount, title=title, category=category, on_date=on_date,
            profile_id=cliutil.profile(s).id,
        )
    cliutil.console.print(f"[green]Cash expense[/] −{amount:.2f}: {title} ({category})")


def reclassify_cmd(
    model: Annotated[
        str | None,
        typer.Option("--model", help="Ollama model for the whole run (default: from config)."),
    ] = None,
    batch_size: Annotated[int, typer.Option("--batch-size", help="Transactions per LLM call.")] = 25,
    limit: Annotated[
        int | None,
        typer.Option("--limit", help="Only the first N signature groups (for testing)."),
    ] = None,
    recent_days: Annotated[
        int | None,
        typer.Option(
            "--recent-days",
            help="Split: use --recent-model for txns in the last N days, --old-model for older.",
        ),
    ] = None,
    recent_model: Annotated[
        str, typer.Option("--recent-model", help="Model for recent txns.")
    ] = "qwen2.5:7b",
    old_model: Annotated[str, typer.Option("--old-model", help="Model for older txns.")] = "qwen2.5:3b",
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
        pid = cliutil.profile(s).id
        if recent_days is not None:
            cutoff = _date.today() - timedelta(days=recent_days)  # noqa: DTZ011 - local dates
            cliutil.console.print(
                f"[bold]Last {recent_days} days[/] (from {cutoff}) → {recent_model}"
            )
            r1 = reclassify_all(
                s, model=recent_model, batch_size=batch_size, limit=limit,
                date_from=cutoff, progress=_mk_progress(recent_model), profile_id=pid,
            )
            cliutil.console.print(
                f"\n[bold]Older[/] (up to {cutoff - timedelta(days=1)}) → {old_model}"
            )
            r2 = reclassify_all(
                s, model=old_model, batch_size=batch_size, limit=limit,
                date_to=cutoff - timedelta(days=1), progress=_mk_progress(old_model),
                profile_id=pid,
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
                progress=_mk_progress(model or "llm"), profile_id=pid,
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
        n = recategorize_merchant(
            s, normalize_text(merchant), category, profile_id=cliutil.profile(s).id
        )
    cliutil.console.print(f"[green]{normalize_text(merchant)} → {category}[/] ({n} transactions)")


# --------------------------------------------------------------------------- #
# Enable Banking
# --------------------------------------------------------------------------- #

def _sync_session(client, session_id: str, *, bank: str | None, days: int, profile_id: int) -> str:
    """Fetch one EB session (network, no DB transaction open), then store each
    account in its own short write transaction; prints a line per account.
    Returns the institution id the session belongs to."""
    from .ingestion.enable_banking.sync import fetch_session, store_account

    fetched = fetch_session(client, session_id, bank=bank, days=days)
    errors = list(fetched.errors)
    for fa in fetched.accounts:
        try:
            with get_session() as s:  # commits on exit
                r = store_account(s, fa, fetched.bank, profile_id=profile_id)
                cliutil.console.print(
                    f"  {r.account.bank} '{r.account.name}': "
                    f"+{r.batch.num_inserted} ({r.batch.num_duplicates} dup)"
                )
        except Exception as e:  # noqa: BLE001 - one bad account must not abort the others
            errors.append(f"{fa.uid}: {e}")
    for err in errors:
        cliutil.console.print(f"[yellow]  account skipped (transient? e.g. rate limit) — {err}[/]")
    return fetched.bank


def _legacy_owner() -> str | None:
    with get_session() as s:
        return profiles.legacy_owner_slug(s)


def _save_session(slug: str, session_id: str | None, institution: str | None, keep: bool) -> None:
    from .ingestion.enable_banking.state import save_session

    if institution and session_id:
        save_session(
            slug, institution, session_id, keep_others=keep, legacy_profile=_legacy_owner()
        )


BankOption = Annotated[str | None, typer.Option(help="Override bank mapping (institution id).")]
DaysOption = Annotated[int, typer.Option()]
KeepOption = Annotated[
    bool,
    typer.Option(
        "--add-session",
        help="Keep the profile's other sessions of this bank (e.g. a second person's login).",
    ),
]


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
def eb_banks(country: Annotated[str | None, typer.Option()] = None) -> None:
    """List available banks (ASPSPs) for a country."""
    aspsps = _client().get_aspsps(country or settings.eb_country)
    table = Table(title=f"ASPSPs ({country or settings.eb_country})")
    table.add_column("name")
    table.add_column("country")
    table.add_column("institution")
    for a in aspsps:
        inst = institutions.from_aspsp(a.get("name"))
        table.add_row(str(a.get("name")), str(a.get("country")), inst.id if inst else "-")
    cliutil.console.print(table)


@eb_app.command("auth")
@eb_guard
def eb_auth(
    aspsp: Annotated[str, typer.Argument(help="Exact ASPSP name from `eb banks`.")],
    country: Annotated[str | None, typer.Option()] = None,
    days: DaysOption = 90,
) -> None:
    """Start bank authorization; open the printed URL and complete SCA login."""
    res = _client().start_authorization(aspsp, country or settings.eb_country, valid_days=days)
    cliutil.console.print(
        "[bold]Open this URL, log in to your bank, then copy the `code` "
        "query param from the redirect URL:[/]"
    )
    cliutil.console.print(res.get("url", res))


@eb_app.command("login")
@eb_guard
def eb_login(
    aspsp: Annotated[str, typer.Argument(help="Exact ASPSP name from `eb banks`.")],
    bank: BankOption = None,
    country: Annotated[str | None, typer.Option()] = None,
    days: DaysOption = 90,
    add_session: KeepOption = False,
) -> None:
    """One-shot: authorize, auto-capture the redirect code, and sync.

    Opens your browser for the bank login (SCA), then listens on the redirect
    URL (FINANSE_EB_REDIRECT_URL — must be whitelisted in the EB control panel)
    to capture the code automatically. The session is saved for the active profile.
    """
    import webbrowser

    from .ingestion.enable_banking.callback import wait_for_authorization_code

    init_db()
    bank = _check_bank(bank, csv=False)
    pid, slug = _active_profile()
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
    institution = _sync_session(client, session_id, bank=bank, days=days, profile_id=pid)
    _save_session(slug, session_id, institution, add_session)
    cliutil.console.print(
        f"[dim]Session saved for profile '{slug}'; re-sync later with `finanse eb resync`. "
        "After both banks, run `finanse match-transfers`.[/]"
    )


@eb_app.command("connect")
@eb_guard
def eb_connect(
    code: Annotated[str, typer.Argument(help="`code` from the redirect URL after login.")],
    bank: BankOption = None,
    days: DaysOption = 90,
    add_session: KeepOption = False,
) -> None:
    """Exchange the redirect code for a session and sync it immediately."""
    init_db()
    bank = _check_bank(bank, csv=False)
    pid, slug = _active_profile()
    client = _client()
    eb_session = client.create_session(code)
    session_id = eb_session.get("session_id")
    cliutil.console.print(f"[green]Session created:[/] {session_id}")
    institution = _sync_session(client, session_id, bank=bank, days=days, profile_id=pid)
    _save_session(slug, session_id, institution, add_session)


@eb_app.command("sync")
@eb_guard
def eb_sync(
    session_id: Annotated[str, typer.Argument()],
    bank: BankOption = None,
    days: DaysOption = 90,
) -> None:
    """Re-sync an existing authorized session."""
    init_db()
    bank = _check_bank(bank, csv=False)
    pid, _slug = _active_profile()
    _sync_session(_client(), session_id, bank=bank, days=days, profile_id=pid)


@eb_app.command("sessions")
def eb_sessions() -> None:
    """List the saved Open Banking sessions of the active profile."""
    from .ingestion.enable_banking.state import load_sessions

    init_db()
    _pid, slug = _active_profile(create=False)
    saved = load_sessions(slug, legacy_profile=_legacy_owner())
    if not saved:
        cliutil.console.print(f"No saved sessions for profile '{slug}'.")
        return
    table = Table(title=f"Open Banking sessions ({slug})")
    for col in ("bank", "session", "saved"):
        table.add_column(col)
    for e in saved:
        table.add_row(
            institutions.display_name(e.institution), f"{e.session_id[:8]}...", e.saved_at or "-"
        )
    cliutil.console.print(table)


@eb_app.command("reprocess")
def eb_reprocess() -> None:
    """Re-derive titles/notes for already-synced Open Banking transactions from raw.

    Fixes rows imported before the field-mapping fix (opaque entry_reference had
    been stored as the transaction title)."""
    from .ingestion.enable_banking.sync import reprocess_open_banking_fields

    init_db()
    with get_session() as s:
        n = reprocess_open_banking_fields(s, profile_id=cliutil.profile(s).id)
    cliutil.console.print(f"[green]Updated {n} transactions[/] (titles/notes from Open Banking).")


@eb_app.command("resync")
@eb_guard
def eb_resync(days: DaysOption = 90) -> None:
    """Re-sync every saved session of the active profile (from `eb login`/`connect`).

    Each bank is fetched with no database transaction open, then each account is
    stored in its own short transaction (other commands and the dashboard keep
    working meanwhile)."""
    from .ingestion.enable_banking.client import EnableBankingError
    from .ingestion.enable_banking.state import load_sessions

    init_db()
    pid, slug = _active_profile(create=False)
    sessions = load_sessions(slug, legacy_profile=_legacy_owner())
    if not sessions:
        cliutil.console.print("[yellow]No saved sessions. Run `finanse eb login` first.[/]")
        raise typer.Exit(1)

    client = _client()
    for saved in sessions:
        cliutil.console.print(f"[bold]{saved.institution}[/] (session {saved.session_id[:8]}…)")
        try:
            _sync_session(
                client, saved.session_id, bank=saved.institution, days=days, profile_id=pid
            )
        except EnableBankingError as e:  # expired/rate-limited session — try the rest
            cliutil.console.print(f"[yellow]  {saved.institution}: {e}[/]")


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
