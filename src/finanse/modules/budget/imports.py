"""In-app statement import: preview (read-only) -> commit (one short write transaction).

The app's ``Import wyciągu`` drawer (first steps, the tabbar ``Import``) uploads a bank statement; the
preview stages the bytes in the data dir, parses them with the chosen importer and reports what a
commit would do without writing anything; the commit re-parses the staged file and writes it through
the same service functions the CLI uses (``service.import_statement`` = ``import-csv``, then
``match_internal_transfers`` and ``categorize_all`` as ``/resync`` does).

Importers (the ``bank`` field; ``importer`` is accepted as an alias):

- ``auto`` (default): a ``finanse-budget-import`` document, else the bank whose CSV signature
  matches best;
- an institution id with a CSV parser (``mbank``, ``erste``, ``pekao``: ``institutions.csv_ids()``);
- ``finanse-budget``: the documented format (``docs/budget-import-format.md``);
- ``connector:<id>``: an approved file connector (F10). The HTTP layer runs it before the preview
  (:func:`run_connector`, no database session open) and stages the converted
  ``finanse-budget-import`` document in place of the upload; :func:`convert` then reads the staged
  document with :func:`from_document` (rows marked ``Source.CONNECTOR``), so the commit never runs the
  connector again. ``auto`` asks the approved connectors only when neither the finanse format nor a
  built-in bank recognises the file.

Duplicates: a document (the finanse format or a connector, file or fetch) goes through the
newest-day rule as Open Banking does (``ingestion/dedup.py`` point 3): rows the id and the content key
do not match are ``overlap`` when stored history covers them (older than the account's newest stored
day, or that day's twin of the same amount); they are not inserted, counted in ``counts.overlap`` and
reported as a warning ``import.overlap`` (a sync with overlap is never auto-committed). Built-in bank
CSV parsers keep the plain dedup (a CSV backfill is the authoritative history).

The target account: ``account_id`` must be a bank account (checking, savings, credit) of the profile;
a document whose ``account.currency`` differs from the target account's currency is refused
(``import_currency_mismatch``; its balances would land in the wrong currency). The importer of every
app import is remembered per account (``import_batches.notes``: ``sha256:<hex> importer:<id>``):
``auto`` asks the account's last connector first and the preview reports it
(``account.remembered_importer``).

Errors are :class:`ImportProblem` with a stable ``code`` (sent as ``X-Finanse-Error-Code``) and an
English, value-free message.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import func, or_
from sqlmodel import Session, select

from finanse.core import account_types, institutions, paths
from finanse.core.accounts import find_account
from finanse.core.api import f
from finanse.core.models import Account, AccountType, Profile, Source
from finanse.core.text import iban_key, normalize_text

from .ingestion import canonical
from .ingestion.csv_import import ParsedStatement, detect_importer, get_importer
from .ingestion.dedup import prepare_new_transactions
from .models import ImportBatch, Transaction

AUTO = "auto"
MODULE_ID = "budget"
CONNECTOR_PREFIX = "connector:"
MAX_FILE_BYTES = 20 * 1024 * 1024
"""Largest statement file the app takes (bank exports are a few hundred KiB)."""
SAMPLE_ROWS = 50
STAGING_MAX_AGE = 24 * 3600.0
ACCOUNT_TYPES = (AccountType.CHECKING, AccountType.SAVINGS, AccountType.CREDIT)
"""Account types a new statement account can get in the app (the drawer's ``Typ konta``), and the
types of a bank account a statement may go into (``account_id``)."""

_SHA = re.compile(r"^[0-9a-f]{64}$")
_EXT = re.compile(r"^[a-z0-9]{1,10}$")
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_log = logging.getLogger("finanse.budget.imports")

FORMAT_NAME = "Format finanse"


class ImportProblem(Exception):
    """A request the import refuses (``code`` -> ``X-Finanse-Error-Code``, HTTP ``status``)."""

    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


# --- importer choices ------------------------------------------------------------------------------


def importer_choices() -> list[dict]:
    """What the drawer's ``Bank`` select offers, in order: ``auto``, every bank with a CSV parser,
    the finanse format, then every file connector of the budget module (``connector:<id>``, kind
    ``connector``; ``available`` only when approved, plus ``status``, ``extensions``, ``timeout_s``)."""
    from finanse.core.connectors import imports as connector_imports

    out = [{"id": AUTO, "name": "rozpoznaj automatycznie", "kind": "auto", "available": True}]
    out += [
        {"id": inst.id, "name": inst.name, "kind": "bank", "available": True}
        for inst in institutions.all_institutions()
        if inst.csv_importer
    ]
    out.append({"id": canonical.IMPORTER_ID, "name": FORMAT_NAME, "kind": "format", "available": True})
    out += connector_imports.importer_entries(MODULE_ID)
    return out


def normalized_choice(importer: str | None) -> str:
    choice = (importer or "").strip()
    return choice.lower() if choice else AUTO


# --- converting a file to a statement ------------------------------------------------------------


@dataclass
class Converted:
    """A parsed statement plus how it was read."""

    statement: ParsedStatement
    importer: str  # the id to send back on commit: "mbank" | "finanse-budget" | "connector:<id>"
    importer_name: str
    detected: bool
    source: Source = Source.CSV
    warnings: list[canonical.BudgetIssue] = field(default_factory=list)
    # A document (finanse format, connector) names its account by number across every bank of the
    # profile; a built-in bank parser within its bank (as ``import-csv``). A document also declares
    # its currency (checked against the target account) and goes through the newest-day rule.
    match_any_bank: bool = False

    @property
    def is_document(self) -> bool:
        return self.match_any_bank


def convert(
    path: Path, file_name: str, importer: str | None, *, detected: bool = False
) -> Converted:
    """Read a staged file with the chosen importer (pure: no database, never runs a connector: a
    ``connector:<id>`` file is the converted document). ImportProblem on refusal."""
    choice = normalized_choice(importer)
    if choice.startswith(CONNECTOR_PREFIX):
        return _convert_with_connector(
            choice[len(CONNECTOR_PREFIX):], path, file_name, detected=detected
        )
    if choice == canonical.IMPORTER_ID:
        return from_document(path.read_bytes(), file_name, detected=False)
    if choice == AUTO:
        content = path.read_bytes()
        if canonical.looks_like_budget_document(content, file_name):
            return from_document(content, file_name, detected=True)
        return _convert_bank(path, None)
    if choice in institutions.csv_ids():
        return _convert_bank(path, choice)
    raise ImportProblem(
        "import_bank_unknown",
        f"Unknown importer. Known: {', '.join(c['id'] for c in importer_choices())}, "
        f"{CONNECTOR_PREFIX}<id>.",
    )


def _convert_with_connector(
    connector_id: str, path: Path, file_name: str, *, detected: bool = False
) -> Converted:
    """``connector:<id>``: ``path`` holds the connector's converted document (staged by
    :func:`run_connector`; nothing runs here). The document name ends in ``.json`` for the parser;
    the batch keeps the uploaded file name."""
    from finanse.core.connectors import imports as connector_imports

    if not connector_id:
        raise ImportProblem("import_bank_unknown", "Unknown importer.")
    return from_document(
        path.read_bytes(),
        f"{Path(file_name).stem or 'document'}.json",
        detected=detected,
        importer=connector_imports.choice_of(connector_id),
        importer_name=connector_imports.connector_name(connector_id),
        source=Source.CONNECTOR,
    )


def builtin_recognises(path: Path, file_name: str) -> bool:
    """``auto`` without connectors would read this file (the finanse format or a bank signature)."""
    try:
        content = path.read_bytes()
        if canonical.looks_like_budget_document(content, file_name):
            return True
        return detect_importer(path) is not None
    except (OSError, UnicodeDecodeError, ValueError):
        return False


@dataclass
class ConnectorUpload:
    """A staged upload after a connector converted it (``detected``: chosen by ``auto``)."""

    upload: Upload
    importer: str
    detected: bool


def run_connector(
    slug: str,
    upload: Upload,
    importer: str | None,
    *,
    profile_id: int | None = None,
    account: dict[str, str] | None = None,
    prefer: str | None = None,
) -> ConnectorUpload | None:
    """Before the preview, with no database session open: ``connector:<id>`` runs that approved file
    connector's ``convert``; ``auto`` asks the approved budget file connectors (``detect``) when no
    built-in importer recognises the file. The converted document replaces the staged upload (same
    file name, its own ``file_id``). None = no connector involved (the preview goes on as before).
    ``prefer``: the account's remembered importer (``auto`` asks that connector first). Raises
    ``ConnectorRunFailed`` (the owner's 422 ``connector_<kind>``)."""
    from finanse.core.connectors import imports as connector_imports

    choice = normalized_choice(importer)
    cid = connector_imports.connector_id_of(choice)
    if cid is None:
        if choice != AUTO or builtin_recognises(upload.path, upload.file_name):
            return None
        if not connector_imports.file_connectors(MODULE_ID, upload.file_name):
            return None
        converted = connector_imports.detect_and_convert(
            MODULE_ID, upload.path, upload.file_name, profile_id=profile_id, account=account,
            prefer=connector_imports.connector_id_of(prefer or ""),
        )
        if converted is None:
            return None
    else:
        if not cid:
            raise ImportProblem("import_bank_unknown", "Unknown importer.")
        converted = connector_imports.convert(
            cid, MODULE_ID, upload.path, upload.file_name, profile_id=profile_id, account=account
        )
    upload.path.unlink(missing_ok=True)  # the original statement is not kept
    staged = stage(slug, upload.file_name, converted.content)
    return ConnectorUpload(staged, connector_imports.choice_of(converted.connector_id), converted.detected)


def from_document(
    content: bytes,
    file_name: str,
    *,
    detected: bool = False,
    importer: str = canonical.IMPORTER_ID,
    importer_name: str = FORMAT_NAME,
    source: Source = Source.CSV,
) -> Converted:
    """A ``finanse-budget-import`` document (JSON or CSV) as a statement. Blocking issues ->
    ImportProblem ``import_invalid`` with the first issues (value-free) in the message."""
    result = canonical.parse_budget_document(content, file_name, source=source)
    if not result.ok or result.statement is None:
        blocking = result.blocking
        shown = "; ".join(str(i) for i in blocking[:5])
        more = f" (+{len(blocking) - 5} more)" if len(blocking) > 5 else ""
        raise ImportProblem("import_invalid", f"The document is not valid: {shown}{more}")
    stmt = result.statement
    if not stmt.transactions and not stmt.closing_balances and not stmt.balances:
        raise ImportProblem("import_empty", "The file holds no transactions")
    return Converted(
        stmt,
        importer,
        importer_name,
        detected,
        source=source,
        warnings=result.warnings,
        match_any_bank=True,
    )


def _convert_bank(path: Path, bank: str | None) -> Converted:
    detected = bank is None
    try:
        parser = get_importer(bank) if bank else detect_importer(path)
    except UnicodeDecodeError:
        raise ImportProblem("import_file_format", "The file cannot be read as text") from None
    except ValueError:
        raise ImportProblem("import_bank_unknown", "Unknown bank") from None
    if parser is None:
        raise ImportProblem(
            "import_bank_unknown",
            "Could not recognise the bank of this file. Choose one of: "
            + ", ".join(institutions.csv_ids())
            + ".",
        )
    try:
        stmt = parser.parse(path)
    except UnicodeDecodeError:
        raise ImportProblem("import_file_format", "The file cannot be read as text") from None
    except ValueError as e:
        if "header" in str(e):
            raise ImportProblem(
                "import_header_missing",
                f"No transaction header of {institutions.display_name(parser.bank)} in this file",
            ) from None
        raise ImportProblem("import_file_format", "Unsupported or damaged file") from None
    except Exception:  # noqa: BLE001 - a parser crash on a strange file is a refusal, never a 500
        _log.exception("statement parser %s failed", parser.bank)
        raise ImportProblem("import_file_format", "Unsupported or damaged file") from None
    if not stmt.transactions:
        raise ImportProblem("import_empty", "The file holds no transactions")
    return Converted(stmt, parser.bank, institutions.display_name(parser.bank), detected)


# --- the target account ------------------------------------------------------------------------


@dataclass
class Target:
    """The account a statement goes to: an existing one, or what a commit will create."""

    account: Account | None
    bank: str
    name: str
    currency: str
    iban: str | None
    external_id: str | None = None

    @property
    def existing(self) -> bool:
        return self.account is not None


def _name_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalize_text(name).lower()).strip("-") or "konto"


def resolve_account(
    session: Session,
    profile: Profile,
    stmt: ParsedStatement,
    *,
    account_id: int | None = None,
    account_name: str | None = None,
    by_any_bank: bool = False,
    check_currency: bool = False,
) -> Target:
    """Read-only: the profile's account the statement belongs to.

    ``account_id``: that account (a bank account of the profile: checking, savings or credit, not
    manual, not removed; 404 ``not_found`` otherwise; 422 ``import_account_mismatch`` when the statement
    names another account number). ``check_currency`` (documents, which declare their currency): 422
    ``import_currency_mismatch`` when an existing target account has another currency.
    Else by account number: within the bank (built-in bank parsers, like ``import-csv``) or across
    every bank of the profile (``by_any_bank``: the finanse format and connectors). A statement
    without a number goes to the account named ``account_name`` (or the document's name) created by an
    earlier app import of the same bank, so a re-import never makes a second account."""
    if account_id is not None:
        acc = session.get(Account, account_id)
        if (
            acc is None
            or acc.profile_id != profile.id
            or acc.removed_at is not None
            or acc.bank == institutions.MANUAL
            or acc.type not in ACCOUNT_TYPES
        ):
            raise ImportProblem("not_found", "No bank account with this id in the profile", 404)
        if stmt.account_number and acc.iban and iban_key(acc.iban) != iban_key(stmt.account_number):
            raise ImportProblem(
                "import_account_mismatch", "The file belongs to another account number"
            )
        return _checked(Target(acc, acc.bank, acc.name, acc.currency, acc.iban), stmt, check_currency)

    iban = stmt.account_number
    name = (account_name or stmt.account_name or "").strip()
    if iban:
        acc = find_account(
            session, bank=None if by_any_bank else stmt.bank, iban=iban, profile_id=profile.id
        )
        if acc is not None:
            target = Target(acc, acc.bank, acc.name, acc.currency, acc.iban)
            return _checked(target, stmt, check_currency)
        default = f"{institutions.display_name(stmt.bank)} {iban[-4:]}"
        return Target(None, stmt.bank, name or default, stmt.currency, iban)

    name = name or institutions.display_name(stmt.bank)
    external_id = f"import:{_name_key(name)}"
    acc = find_account(session, bank=stmt.bank, external_id=external_id, profile_id=profile.id)
    if acc is not None:
        return _checked(Target(acc, acc.bank, acc.name, acc.currency, acc.iban), stmt, check_currency)
    return Target(None, stmt.bank, name, stmt.currency, None, external_id)


def _checked(target: Target, stmt: ParsedStatement, check_currency: bool) -> Target:
    """A document in another currency than the existing target account is refused: its amounts and
    balances would be stored as the account's currency (BE-3)."""
    if (
        check_currency
        and target.account is not None
        and (stmt.currency or "").upper() != (target.currency or "").upper()
    ):
        raise ImportProblem(
            "import_currency_mismatch",
            f"The file is in {(stmt.currency or '?').upper()[:3]}, "
            f"the account in {(target.currency or '?').upper()[:3]}",
        )
    return target


# --- preview ------------------------------------------------------------------------------------


@dataclass
class Upload:
    file_id: str
    file_name: str
    path: Path


def staging_dir(slug: str) -> Path:
    if not _SLUG.match(slug):
        raise ValueError("Not a profile slug")
    return paths.data_dir() / "imports" / slug / ".staging"


def staged_path(slug: str, file_id: str, file_name: str) -> Path:
    """``<data dir>/imports/<slug>/.staging/budget-<sha256>.<ext>`` (ImportProblem on a bad id)."""
    if not _SHA.match(file_id or ""):
        raise ImportProblem("not_found", "No staged file with this id; preview it again", 404)
    ext = Path(file_name or "").suffix.lower().lstrip(".")
    return staging_dir(slug) / f"budget-{file_id}.{ext if _EXT.match(ext) else 'bin'}"


def stage(slug: str, file_name: str, content: bytes) -> Upload:
    """Write the upload owner-only into the staging dir (atomically); older budget uploads than a
    day are removed on the way (an abandoned preview never keeps a statement around)."""
    digest = hashlib.sha256(content).hexdigest()
    path = staged_path(slug, digest, file_name)
    folder = path.parent
    for part in (paths.data_dir(), folder.parent.parent, folder.parent, folder):
        paths.ensure_private_dir(part)
    _prune(folder)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(content)
    tmp.chmod(0o600)
    tmp.replace(path)
    return Upload(digest, file_name, path)


def _prune(folder: Path) -> None:
    now = time.time()
    try:
        for old in folder.glob("budget-*"):
            if old.is_file() and not old.is_symlink() and now - old.stat().st_mtime > STAGING_MAX_AGE:
                old.unlink(missing_ok=True)
    except OSError:
        _log.exception("cannot prune staged statements")


def _iban_tail(iban: str | None) -> str | None:
    return (iban or "")[-4:] or None


def _account_type(value: str | None) -> str:
    kind = (value or AccountType.CHECKING).strip()
    if kind not in ACCOUNT_TYPES or kind not in account_types.ids():
        raise ImportProblem(
            "import_account_type", f"account_type must be one of: {', '.join(ACCOUNT_TYPES)}"
        )
    return kind


def _sha_note(digest: str) -> str:
    return f"sha256:{digest}"


IMPORTER_NOTE = "importer:"


def _batch_note(digest: str, importer: str) -> str:
    """``import_batches.notes`` of an app import: the file hash, then the importer used."""
    return f"{_sha_note(digest)} {IMPORTER_NOTE}{importer}"


def remembered_importer(session: Session, account_id: int | None) -> str | None:
    """The importer of the account's newest app import (``connector:<id>``, a bank id, ...)."""
    if account_id is None:
        return None
    rows = session.exec(
        select(ImportBatch.notes)
        .where(ImportBatch.account_id == account_id, ImportBatch.notes.like(f"% {IMPORTER_NOTE}%"))
        .order_by(ImportBatch.started_at.desc(), ImportBatch.id.desc())
        .limit(1)
    ).all()
    for notes in rows:
        token = next((t for t in (notes or "").split() if t.startswith(IMPORTER_NOTE)), None)
        if token and len(token) > len(IMPORTER_NOTE):
            return token[len(IMPORTER_NOTE):]
    return None


def preview(
    session: Session,
    profile: Profile,
    upload: Upload,
    *,
    importer: str | None = None,
    account_type: str | None = None,
    account_name: str | None = None,
    account_id: int | None = None,
    detected: bool = False,
) -> dict:
    """What a commit of the staged file would do (read-only; see the module doc for the shape).
    ``detected``: a ``connector:<id>`` importer that ``auto`` chose."""
    _account_type(account_type)
    converted = convert(upload.path, upload.file_name, importer, detected=detected)
    stmt = converted.statement
    target = resolve_account(
        session,
        profile,
        stmt,
        account_id=account_id,
        account_name=account_name,
        by_any_bank=converted.match_any_bank,
        check_currency=converted.is_document,
    )
    warnings = [w.as_dict() for w in converted.warnings]
    if target.account is not None:
        dedup = prepare_new_transactions(
            session, target.account.id, stmt.transactions, newest_day_rule=converted.is_document
        )
        statuses = dedup.statuses
        if dedup.num_overlap:
            warnings.append(_overlap_issue(dedup.num_overlap).as_dict())
        n_existing = int(
            session.exec(
                select(func.count(Transaction.id)).where(Transaction.account_id == target.account.id)
            ).one()
            or 0
        )
    else:
        statuses = ["new"] * len(stmt.transactions)
        n_existing = 0
    n_new = statuses.count("new")
    n_overlap = statuses.count("overlap")
    dates = [t.booking_date for t in stmt.transactions]
    eod = {d for d, _ in stmt.balances} | {d for d, _ in stmt.closing_balances}
    rows = [
        {
            "row": i + 1,
            "date": t.booking_date.isoformat(),
            "amount": f(t.amount),
            "currency": t.currency.upper(),
            "title": t.reference or t.description,
            "counterparty": t.counterparty_name,
            "status": "duplicate" if status == "overlap" else status,
            "overlap": status == "overlap",
        }
        for i, (t, status) in enumerate(zip(stmt.transactions, statuses, strict=True))
    ][:SAMPLE_ROWS]
    return {
        "file_id": upload.file_id,
        "file_name": upload.file_name,
        "bank": {
            "id": converted.importer,
            "name": converted.importer_name,
            "detected": converted.detected,
        },
        "account": {
            "existing": target.existing,
            "id": target.account.id if target.account is not None else None,
            "name": target.name,
            "currency": target.currency,
            "iban_tail": _iban_tail(target.iban),
            "transactions": n_existing,
            "institution": {"id": target.bank, "name": institutions.display_name(target.bank)},
            "remembered_importer": remembered_importer(
                session, target.account.id if target.account is not None else None
            ),
        },
        "counts": {
            "rows": len(stmt.transactions) + stmt.skipped_rows,
            "new": n_new,
            "duplicates": len(statuses) - n_new,
            "overlap": n_overlap,
            "skipped": stmt.skipped_rows,
        },
        "range": {"from": min(dates).isoformat(), "to": max(dates).isoformat()} if dates else None,
        "balances": len(eod),
        "rows": rows,
        "previous_imports": previous_imports(session, profile, upload),
        "warnings": warnings,
    }


def _overlap_issue(count: int) -> canonical.BudgetIssue:
    return canonical.BudgetIssue(
        canonical.IssueKind.OVERLAP,
        f"{count} rows are already covered by the account's stored history (another source: bank "
        "CSV, Open Banking); they are skipped",
        blocking=False,
    )


def previous_imports(session: Session, profile: Profile, upload: Upload, limit: int = 5) -> list[dict]:
    """Earlier imports of this exact file (same sha256: ``same_file``) or of a file with the same
    name (CLI imports carry no hash), newest first."""
    note = _sha_note(upload.file_id)
    rows = session.exec(
        select(ImportBatch)
        .where(
            ImportBatch.profile_id == profile.id,
            or_(
                ImportBatch.notes == note,
                ImportBatch.notes.like(f"{note} %"),
                ImportBatch.filename == upload.file_name,
            ),
        )
        .order_by(ImportBatch.started_at.desc(), ImportBatch.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "at": (b.finished_at or b.started_at).date().isoformat(),
            "file_name": b.filename,
            "inserted": b.num_inserted,
            "same_file": (b.notes or "").split(" ")[0] == note,
        }
        for b in rows
    ]


# --- commit ---------------------------------------------------------------------------------------


def commit(
    session_factory: Callable,
    profile: Profile,
    upload: Upload,
    *,
    importer: str | None = None,
    account_type: str | None = None,
    account_name: str | None = None,
    account_id: int | None = None,
) -> dict:
    """Write the staged file: parse first (no transaction open), then ONE short write transaction
    (statement, transfers, categories); the staged file is removed afterwards."""
    from .ingestion.transfers import match_internal_transfers
    from .service import categorize_all, import_statement

    kind = _account_type(account_type)
    converted = convert(upload.path, upload.file_name, importer)
    stmt = converted.statement
    with session_factory() as s:
        target = resolve_account(
            s,
            profile,
            stmt,
            account_id=account_id,
            account_name=account_name,
            by_any_bank=converted.match_any_bank,
            check_currency=converted.is_document,
        )
        account, batch = import_statement(
            s,
            stmt,
            account=target.account,
            account_type=kind,
            account_name=target.name,
            external_id=target.external_id,
            profile_id=profile.id,
            source=converted.source,
            filename=upload.file_name,
            notes=_batch_note(upload.file_id, converted.importer),
            newest_day_rule=converted.is_document,
        )
        s.flush()
        pairs = match_internal_transfers(s, profile_id=profile.id)
        categorize_all(s, profile_id=profile.id)
        s.flush()
        categorized = int(
            s.exec(
                select(func.count(Transaction.id)).where(
                    Transaction.import_batch_id == batch.id,
                    Transaction.category_source.is_not(None),
                    Transaction.category_source != "default",
                )
            ).one()
            or 0
        )
        out = {
            "batch_id": batch.id,
            "account": {
                "id": account.id,
                "name": account.name,
                "currency": account.currency,
                "iban_tail": _iban_tail(account.iban),
                "created": not target.existing,
            },
            "inserted": batch.num_inserted,
            "duplicates": batch.num_duplicates,
            "skipped": stmt.skipped_rows,
            "balances": len({d for d, _ in stmt.balances} | {d for d, _ in stmt.closing_balances}),
            "categorized": categorized,
            "transfer_pairs": pairs,
        }
    upload.path.unlink(missing_ok=True)
    return out
