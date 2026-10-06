"""ImportService: preview and commit of a broker file for one brokerage account, and reconciliation
against the broker's position snapshot.

``preview`` is read-only: importer selection, parsing, ``plan_import`` over the stored instruments
and dedup hashes, plus the service-level notes (same file imported before, file source vs the
account's broker, several importers recognising the file) and a reconciliation of the file's
position lines against the history after the import.

``commit`` archives the file to ``<data dir>/imports/<slug>/<sha256>.<ext>`` first, then writes
everything in ONE short transaction: planned instruments are re-resolved by their confirmed aliases
(a concurrent import may have created them), new instruments and aliases are inserted, transaction
hashes are recomputed over the whole file with the final instrument ids, the non-duplicate rows are
inserted re-stamped from the commit time in their chronological order, then position snapshots,
renames, delisting status (frozen -> a manual valuation of 0) and the selected reconciliation
corrections. Any failure rolls the whole commit back.
"""

from __future__ import annotations

import datetime as dt
import itertools
from collections.abc import Callable, Collection
from contextlib import AbstractContextManager
from dataclasses import dataclass, field, replace
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core import institutions
from finanse.core.db import get_session
from finanse.core.models import Account, Profile, utcnow

from ..domain import (
    Currency,
    InstrumentId,
    InstrumentRename,
    InstrumentStatus,
    PortfolioSnapshot,
    Transaction,
)
from ..importing import (
    GENERIC_CSV_BROKER_ID,
    BrokerImporter,
    CanonicalImporter,
    CsvMapping,
    CsvMappingError,
    DedupInput,
    GenericCsvImporter,
    ImportFile,
    ImportParseResult,
    ImportPlan,
    ImportWarning,
    ImportWarningKind,
    ReconciliationReport,
    dedup_hashes,
    default_registry,
    effective_broker_id,
    plan_import,
    reconcile,
)
from ..importing.reconciler import BrokerPosition
from ..importing.validation import MAX_FILE_BYTES
from ..models import (
    InvAccountSettings,
    InvImportBatch,
    InvInstrument,
    InvInstrumentRename,
    InvPositionSnapshot,
    InvTransaction,
)
from ..portfolio import build_snapshot
from ..store import convert, instruments, transactions
from . import files
from . import planned as planned_service

AUTO = "auto"
IMPORTER_CHOICES = (AUTO, "finanse", GENERIC_CSV_BROKER_ID)
CONNECTOR_PREFIX = "connector:"
"""``connector:<id>``: an approved file connector (F10). The service never runs it: the HTTP layer runs
the connector's ``convert`` first and passes the converted ``finanse-import`` document as the file,
which is then read like the canonical format (also what is staged and archived)."""
SessionFactory = Callable[[], AbstractContextManager[Session]]


class ImportFailure(ValueError):
    """The import cannot go on (message safe to show the user)."""


class AccountNotFound(ImportFailure):
    pass


@dataclass(frozen=True)
class ImportRequest:
    file: ImportFile
    account_id: int
    importer: str = AUTO  # auto | finanse | generic_csv | connector:<id>
    mapping_yaml: str | None = None
    connector_name: str | None = None  # display name of a connector:<id> importer
    requested: str | None = None  # what the user chose when it differs (auto -> a detected connector)
    bound_account: bool = False
    """A fetch connector's binding names the account (the owner's choice): no "source vs the
    account's broker" note (a connector's ``source`` is its author's label)."""


@dataclass
class ImportPreview:
    profile: Profile
    account: Account
    request: ImportRequest
    sha256: str
    importer_id: str | None = None
    importer_name: str | None = None
    detected: tuple[str, ...] = ()
    parse: ImportParseResult | None = None
    plan: ImportPlan | None = None
    notes: list[ImportWarning] = field(default_factory=list)
    """Service-level notes (same file, broker mismatch, several importers)."""
    blocking: list[ImportWarning] = field(default_factory=list)
    """Service-level blocking problems (no importer, unreadable mapping, importer crash)."""
    previous_batches: list[InvImportBatch] = field(default_factory=list)
    reconciliation: ReconciliationReport | None = None

    @property
    def warnings(self) -> list[ImportWarning]:
        return [*self.notes, *(self.plan.warnings if self.plan else ())]

    @property
    def errors(self) -> list[ImportWarning]:
        return [*self.blocking, *(self.plan.blocking_errors if self.plan else ())]

    @property
    def can_commit(self) -> bool:
        return self.plan is not None and not self.errors


@dataclass
class CommitResult:
    batch_id: int
    inserted: int
    duplicates: int
    new_instrument_ids: list[int]
    positions: int
    renames: int
    status_changes: int
    corrections: int
    archive_path: str
    instrument_map: dict[InstrumentId, int] = field(default_factory=dict)
    """Planned instrument id -> stored instrument key."""
    planned_booked: list[int] = field(default_factory=list)
    """Planned deposits (``service.planned``) booked by this file's deposits."""


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #


def _note(
    message: str, kind: str = ImportWarningKind.OTHER, *, blocking: bool = False
) -> ImportWarning:
    return ImportWarning(message=message, blocking=blocking, kind=kind)


def _choose_importer(preview: ImportPreview, settings: InvAccountSettings) -> BrokerImporter | None:
    request = preview.request
    mapping_text = request.mapping_yaml
    choice = request.importer or AUTO
    if is_connector_choice(choice):
        connector_id = choice[len(CONNECTOR_PREFIX):]
        if request.requested == AUTO:
            preview.detected = (choice,)
        return ConnectorDocumentImporter(choice, request.connector_name or connector_id)
    if choice not in IMPORTER_CHOICES:
        preview.blocking.append(
            _note(
                f"Unknown importer {choice!r}; use one of {', '.join(IMPORTER_CHOICES)}",
                ImportWarningKind.FILE_FORMAT,
                blocking=True,
            )
        )
        return None
    if choice == AUTO and mapping_text is None and settings.mapping_yaml:
        mapping_text = settings.mapping_yaml  # the mapping remembered for this account
    mapping = None
    if mapping_text is not None:
        try:
            mapping = CsvMapping.from_yaml(mapping_text)
        except CsvMappingError as e:
            for issue in e.issues:
                where = f" (line {issue.line})" if issue.line else ""
                preview.blocking.append(
                    _note(
                        f"mapping {issue.path}: {issue.message}{where}",
                        ImportWarningKind.FILE_FORMAT,
                        blocking=True,
                    )
                )
            return None
    if choice == "finanse":
        return CanonicalImporter()
    if choice == GENERIC_CSV_BROKER_ID:
        if mapping is None:
            preview.blocking.append(
                _note(
                    "The generic CSV importer needs a mapping (YAML)",
                    ImportWarningKind.FILE_FORMAT,
                    blocking=True,
                )
            )
            return None
        return GenericCsvImporter(mapping)
    registry = default_registry(*([mapping] if mapping is not None else []))
    found = registry.detect(request.file)
    preview.detected = tuple(i.broker_id for i in found)
    if not found:
        preview.blocking.append(
            _note(
                "No importer recognises this file: use the finanse import format "
                "(docs/import-format.md) or a generic CSV mapping",
                ImportWarningKind.FILE_FORMAT,
                blocking=True,
            )
        )
        return None
    if len(found) > 1:
        preview.notes.append(
            _note(
                f"Several importers recognise this file ({', '.join(preview.detected)}); "
                f"using {found[0].broker_id}",
                ImportWarningKind.FILE_FORMAT,
            )
        )
    return found[0]


def is_connector_choice(choice: str | None) -> bool:
    return bool(choice) and choice.startswith(CONNECTOR_PREFIX) and len(choice) > len(CONNECTOR_PREFIX)


class ConnectorDocumentImporter:
    """A connector's converted document (``finanse-import`` JSON) read with the canonical importer;
    the batch and the account remember ``connector:<id>`` as the importer."""

    def __init__(self, importer_id: str, name: str) -> None:
        self.importer_id = importer_id
        self._name = name
        self._canonical = CanonicalImporter()

    @property
    def broker_id(self) -> str:  # alias namespace when the document has no ``source``
        return self._canonical.broker_id

    @property
    def display_name(self) -> str:
        return self._name

    @property
    def version(self) -> int:
        return self._canonical.version

    @staticmethod
    def _as_json(file: ImportFile) -> ImportFile:
        return ImportFile(f"{file.name}.json", file.content)

    def can_parse(self, file: ImportFile) -> bool:
        return self._canonical.can_parse(self._as_json(file))

    def parse(self, file: ImportFile) -> ImportParseResult:
        return self._canonical.parse(self._as_json(file))


def connector_auto_check(
    session: Session, profile: Profile, request: ImportRequest
) -> tuple[bool, str | None, dict[str, str] | None]:
    """For ``auto`` (read-only): (no built-in importer recognises the file, the connector remembered
    for the account or None, the account facts a connector gets). The caller then asks the approved
    connectors (outside any transaction). An unknown account answers (False, None, None): the preview
    reports it."""
    account = transactions.brokerage_account(session, profile.id, request.account_id)
    if account is None:
        return False, None, None
    settings = transactions.account_settings(session, account.id)
    remembered = settings.importer if is_connector_choice(settings.importer) else None
    facts = {"currency": account.currency, "label": account.name}
    mapping_text = request.mapping_yaml or settings.mapping_yaml
    mapping = None
    if mapping_text:
        try:
            mapping = CsvMapping.from_yaml(mapping_text)
        except CsvMappingError:
            mapping = None
    registry = default_registry(*([mapping] if mapping is not None else []))
    found = registry.detect(request.file)
    prefer = remembered[len(CONNECTOR_PREFIX):] if remembered else None
    return not found, prefer, facts


def account_facts(session: Session, profile: Profile, account_id: int) -> dict[str, str] | None:
    """What a connector is told about the target account (currency, label); None when unknown."""
    account = transactions.brokerage_account(session, profile.id, account_id)
    return None if account is None else {"currency": account.currency, "label": account.name}


def preview(
    session: Session,
    profile: Profile,
    request: ImportRequest,
    *,
    now: dt.datetime | None = None,
) -> ImportPreview:
    """What committing ``request`` would do (read-only)."""
    account = transactions.brokerage_account(session, profile.id, request.account_id)
    if account is None:
        raise AccountNotFound(f"No brokerage account {request.account_id} in this profile")
    if len(request.file.content) > MAX_FILE_BYTES:
        raise ImportFailure(f"File too large (over {MAX_FILE_BYTES // (1024 * 1024)} MB)")
    result = ImportPreview(profile, account, request, files.sha256(request.file.content))
    settings = transactions.account_settings(session, account.id)
    importer = _choose_importer(result, settings)
    if importer is None:
        return result
    result.importer_id = getattr(importer, "importer_id", importer.broker_id)
    result.importer_name = importer.display_name
    try:
        parsed = importer.parse(request.file)
    except Exception as e:  # noqa: BLE001 - a broken importer must not crash the preview
        result.blocking.append(
            _note(
                f"The importer failed: {type(e).__name__}: {e}",
                ImportWarningKind.IMPORTER_ERROR,
                blocking=True,
            )
        )
        return result
    result.parse = parsed
    broker_id = effective_broker_id(importer, parsed)
    now = convert.aware(now or utcnow())
    # Planned instrument ids are deterministic per file, so a preview repeated at commit time (the
    # API re-plans from the staged file) names the same planned instruments as the first one.
    planned = itertools.count(1)
    result.plan = plan_import(
        parsed,
        account_id=convert.sid(account.id),
        broker_id=broker_id,
        lookup=instruments.DbInstrumentLookup(session),
        existing_hashes=lambda hashes: transactions.existing_hashes(session, account.id, hashes),
        now=now,
        instrument_id_factory=lambda: f"new-{result.sha256[:12]}-{next(planned)}",
    )

    result.previous_batches = list(
        session.exec(
            select(InvImportBatch)
            .where(
                InvImportBatch.profile_id == profile.id, InvImportBatch.file_sha256 == result.sha256
            )
            .order_by(InvImportBatch.created_at)
        ).all()
    )
    if result.previous_batches:
        first = result.previous_batches[0]
        result.notes.append(
            _note(
                f"This file was already imported on {first.created_at.astimezone().date().isoformat()} "
                f"(batch {first.id}); its rows show as duplicates"
            )
        )
    inst = _institution(account.bank)
    if (
        not request.bound_account
        and inst is not None
        and inst.kind in ("broker", "exchange")
        and parsed.source
        and parsed.source != account.bank
    ):
        result.notes.append(
            _note(
                f"The file says source '{parsed.source}' but the account belongs to "
                f"{inst.name} ('{account.bank}'); check the account"
            )
        )
    if result.plan.positions:
        result.reconciliation = _reconcile_planned(session, profile, account, result.plan, now)
    return result


def _institution(institution_id: str):
    try:
        return institutions.get(institution_id)
    except institutions.UnknownInstitution:
        return None


def _reconcile_planned(
    session: Session, profile: Profile, account: Account, plan: ImportPlan, now: dt.datetime
) -> ReconciliationReport:
    """The file's position lines vs the account's history including the planned rows."""
    positions = [p.position for p in plan.positions]
    as_of = max(p.as_of for p in positions)
    history = transactions.transactions(session, profile.id, [account.id])
    renames = transactions.renames(session, profile.id) + [r.rename for r in plan.renames]
    snapshot = build_snapshot(
        convert.sid(profile.id),
        [*history, *plan.transactions_to_insert()],
        as_of,
        account_ids=[convert.sid(account.id)],
        renames=renames,
    )
    return reconcile(convert.sid(account.id), positions, snapshot, now=now)


# --------------------------------------------------------------------------- #
# Commit
# --------------------------------------------------------------------------- #


def commit(
    preview_: ImportPreview,
    *,
    corrections: Collection[str] = (),
    now: dt.datetime | None = None,
    session_factory: SessionFactory = get_session,
) -> CommitResult:
    """Archive the file, then write the previewed import in one transaction (see module doc).
    ``corrections``: instrument ids (planned or stored) whose reconciliation correction to apply."""
    plan = preview_.plan
    if plan is None or not preview_.can_commit:
        problems = "; ".join(str(e) for e in preview_.errors) or "nothing to import"
        raise ImportFailure(f"The file cannot be imported: {problems}")
    profile, account, request = preview_.profile, preview_.account, preview_.request
    archive = files.archive_path(profile.slug, preview_.sha256, request.file.name)
    if not archive.exists():
        files.write_private(archive, request.file.content)
    now = convert.aware(now or utcnow())

    with session_factory() as s:
        batch = InvImportBatch(
            profile_id=profile.id,
            account_id=account.id,
            importer=preview_.importer_id or "",
            broker=plan.broker_id,
            file_name=request.file.name,
            file_sha256=preview_.sha256,
            archive_path=files.relative_to_data_dir(archive),
            position_count=len(plan.positions),
            warnings=[_warning_dict(w) for w in preview_.warnings],
            created_at=now,
        )
        s.add(batch)
        s.flush()

        # 1. Instruments: re-resolve planned ones by confirmed aliases, insert the rest.
        mapping: dict[InstrumentId, int] = {}
        new_ids: list[int] = []
        for planned in plan.new_instruments:
            found = instruments.find_confirmed(s, planned)
            if found is not None:
                mapping[planned.id] = convert.pk(found.id)
                existing_row = s.get(InvInstrument, convert.pk(found.id))
                instruments.add_aliases(s, existing_row, planned.aliases)
            else:
                row = instruments.insert(s, planned)
                mapping[planned.id] = row.id
                new_ids.append(row.id)
        for instrument_id, aliases in plan.new_aliases.items():
            row = s.get(InvInstrument, _resolve(instrument_id, mapping))
            if row is not None:
                instruments.add_aliases(s, row, aliases)

        # 2. Transactions: hashes over the whole file with the final ids; insert new rows in order.
        rows = sorted(plan.rows, key=lambda r: r.txn.created_at)
        final_ids = [
            None if r.txn.instrument_id is None else _resolve(r.txn.instrument_id, mapping)
            for r in rows
        ]
        hashes = dedup_hashes(
            [
                DedupInput.from_parsed(r.parsed, None if i is None else convert.sid(i))
                for r, i in zip(rows, final_ids, strict=True)
            ],
            account_id=convert.sid(account.id),
            broker_id=plan.broker_id,
        )
        stored = transactions.existing_hashes(s, account.id, hashes)
        inserted = duplicates = 0
        for index, (row, instrument_id, digest) in enumerate(
            zip(rows, final_ids, hashes, strict=True)
        ):
            if digest in stored:
                duplicates += 1
                continue
            stored.add(digest)
            txn = replace(row.txn, dedup_hash=digest)
            s.add(
                convert.transaction_row(
                    txn,
                    account_id=account.id,
                    instrument_id=instrument_id,
                    import_batch_id=batch.id,
                    created_at=now + dt.timedelta(milliseconds=index),
                )
            )
            inserted += 1
        s.flush()

        # 3. Broker position snapshots (upsert per instrument and date).
        for planned_position in plan.positions:
            p = planned_position.position
            instrument_id = _resolve(p.instrument_id, mapping)
            snap = s.exec(
                select(InvPositionSnapshot).where(
                    InvPositionSnapshot.account_id == account.id,
                    InvPositionSnapshot.instrument_id == instrument_id,
                    InvPositionSnapshot.as_of == p.as_of,
                )
            ).first() or InvPositionSnapshot(
                account_id=account.id,
                instrument_id=instrument_id,
                as_of=p.as_of,
                quantity=p.quantity,
                currency=str(p.currency),
            )
            snap.quantity, snap.currency = p.quantity, str(p.currency)
            snap.avg_price, snap.market_value = p.avg_price, p.market_value
            snap.import_batch_id, snap.created_at = batch.id, now
            s.add(snap)

        # 4. Renames and delistings.
        renames = 0
        for planned_rename in plan.renames:
            r = planned_rename.rename
            old, new = (
                _resolve(r.old_instrument_id, mapping),
                _resolve(r.new_instrument_id, mapping),
            )
            exists = s.exec(
                select(InvInstrumentRename.id).where(
                    InvInstrumentRename.profile_id == profile.id,
                    InvInstrumentRename.date == r.date,
                    InvInstrumentRename.old_instrument_id == old,
                    InvInstrumentRename.new_instrument_id == new,
                )
            ).first()
            if exists is None:
                s.add(
                    InvInstrumentRename(
                        profile_id=profile.id,
                        date=r.date,
                        old_instrument_id=old,
                        new_instrument_id=new,
                        note=r.note,
                        import_batch_id=batch.id,
                        created_at=now,
                    )
                )
                renames += 1
        for change in plan.status_changes:
            instrument_id = _resolve(change.instrument_id, mapping)
            instruments.set_status(s, instrument_id, change.status, profile_id=profile.id)
            if change.status == InstrumentStatus.FROZEN:
                row = s.get(InvInstrument, instrument_id)
                transactions.upsert_manual_valuation(
                    s,
                    profile.id,
                    instrument_id,
                    change.parsed.date,
                    Decimal(0),
                    row.currency,
                    note=change.parsed.note or "frozen (import)",
                )
        s.flush()

        # 5. Reconciliation corrections chosen in the preview.
        applied = 0
        if corrections and plan.positions:
            wanted = {_resolve_or_none(c, mapping) for c in corrections} - {None}
            positions = [
                replace(
                    p.position,
                    instrument_id=convert.sid(_resolve(p.position.instrument_id, mapping)),
                )
                for p in plan.positions
            ]
            applied = _apply_corrections(s, profile, account, positions, wanted, now, batch.id)

        # 6. Remember the importer for this account: only a file with transactions (the broker's
        #    statement export); a positions-only / corporate-action-only file (often the canonical
        #    format) must not replace the account's export importer (F7 OB4).
        if plan.rows:
            settings = s.get(InvAccountSettings, account.id) or InvAccountSettings(
                account_id=account.id
            )
            settings.importer = preview_.importer_id
            if preview_.importer_id == GENERIC_CSV_BROKER_ID or request.mapping_yaml:
                settings.mapping_yaml = request.mapping_yaml or settings.mapping_yaml
            settings.updated_at = now
            s.add(settings)

        # 7. Planned deposits this file's deposits book (F6; never cash until then).
        booked = planned_service.book_matching(s, profile.id, now=now) if inserted else []

        batch.txn_count, batch.duplicate_count = inserted, duplicates
        batch.rename_count, batch.status_change_count = renames, len(plan.status_changes)
        batch.instrument_count, batch.correction_count = len(new_ids), applied
        s.add(batch)
        s.flush()
        return CommitResult(
            batch_id=batch.id,
            inserted=inserted,
            duplicates=duplicates,
            new_instrument_ids=new_ids,
            positions=len(plan.positions),
            renames=renames,
            status_changes=len(plan.status_changes),
            corrections=applied,
            archive_path=files.relative_to_data_dir(archive),
            instrument_map=mapping,
            planned_booked=booked,
        )


def _resolve(instrument_id: InstrumentId, mapping: dict[InstrumentId, int]) -> int:
    if instrument_id in mapping:
        return mapping[instrument_id]
    return convert.pk(instrument_id)


def _resolve_or_none(instrument_id: str, mapping: dict[InstrumentId, int]) -> int | None:
    if instrument_id in mapping:
        return mapping[instrument_id]
    return convert.maybe_pk(instrument_id)


def _warning_dict(w: ImportWarning) -> dict:
    return {"message": w.message, "row": w.row, "kind": str(w.kind), "blocking": w.blocking}


# --------------------------------------------------------------------------- #
# Reconciliation against the stored broker snapshot
# --------------------------------------------------------------------------- #


def _account_snapshot(
    session: Session, profile: Profile, account: Account, as_of: dt.date
) -> PortfolioSnapshot:
    history = transactions.transactions(session, profile.id, [account.id])
    return build_snapshot(
        convert.sid(profile.id),
        history,
        as_of,
        account_ids=[convert.sid(account.id)],
        renames=transactions.renames(session, profile.id),
    )


def stored_positions(session: Session, account: Account) -> list[BrokerPosition]:
    _as_of, rows = transactions.latest_position_snapshot(session, account.id)
    return [
        BrokerPosition(
            instrument_id=convert.sid(r.instrument_id),
            quantity=r.quantity,
            currency=Currency(r.currency),
            as_of=r.as_of,
            avg_price=r.avg_price,
            market_value=r.market_value,
        )
        for r in rows
    ]


def reconciliation(
    session: Session, profile: Profile, account_id: int, *, now: dt.datetime | None = None
) -> ReconciliationReport | None:
    """The account's history vs its newest stored broker snapshot (None without a snapshot)."""
    account = transactions.brokerage_account(session, profile.id, account_id)
    if account is None:
        raise AccountNotFound(f"No brokerage account {account_id} in this profile")
    positions = stored_positions(session, account)
    if not positions:
        return None
    snapshot = _account_snapshot(session, profile, account, max(p.as_of for p in positions))
    return reconcile(
        convert.sid(account.id), positions, snapshot, now=convert.aware(now or utcnow())
    )


def apply_reconciliation(
    session: Session,
    profile: Profile,
    account_id: int,
    instrument_ids: Collection[int],
    *,
    now: dt.datetime | None = None,
) -> int:
    """Insert the proposed corrections of the chosen instruments (vs the newest stored snapshot);
    applying the same proposal twice inserts it once. Returns how many were inserted."""
    account = transactions.brokerage_account(session, profile.id, account_id)
    if account is None:
        raise AccountNotFound(f"No brokerage account {account_id} in this profile")
    positions = stored_positions(session, account)
    if not positions:
        return 0
    return _apply_corrections(
        session,
        profile,
        account,
        positions,
        set(instrument_ids),
        convert.aware(now or utcnow()),
        None,
    )


def _apply_corrections(
    session: Session,
    profile: Profile,
    account: Account,
    positions: list[BrokerPosition],
    wanted: set[int],
    now: dt.datetime,
    batch_id: int | None,
) -> int:
    snapshot = _account_snapshot(session, profile, account, max(p.as_of for p in positions))
    report = reconcile(convert.sid(account.id), positions, snapshot, now=now)
    applied = 0
    for index, correction in enumerate(report.corrections):
        txn: Transaction = correction.txn
        instrument_id = convert.pk(txn.instrument_id) if txn.instrument_id is not None else None
        if instrument_id not in wanted:
            continue
        exists = session.exec(
            select(InvTransaction.id).where(
                InvTransaction.account_id == account.id, InvTransaction.dedup_hash == txn.dedup_hash
            )
        ).first()
        if exists is not None:
            continue
        session.add(
            convert.transaction_row(
                txn,
                account_id=account.id,
                instrument_id=instrument_id,
                import_batch_id=batch_id,
                created_at=now + dt.timedelta(milliseconds=index),
            )
        )
        applied += 1
    session.flush()
    return applied


def planned_renames(plan: ImportPlan) -> list[InstrumentRename]:
    return [r.rename for r in plan.renames]
