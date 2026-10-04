"""The pure core of an import preview: resolve, validate, hash and order one parsed file.

``plan_import`` is ``ImportService.preview`` of Kompas without the database: the persistence layer
supplies an :class:`~.resolver.InstrumentLookup` and a function telling which dedup hashes are already
stored, then writes the plan on commit (new instruments, new aliases, non-duplicate transactions,
position snapshot rows, renames and status changes).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..domain import (
    EPOCH,
    AccountId,
    ImportBatchId,
    Instrument,
    InstrumentAlias,
    InstrumentId,
    InstrumentRename,
    InstrumentStatus,
    Transaction,
    TxnId,
    TxnSource,
    TxnType,
)
from .contract import (
    ImportParseResult,
    ImportWarning,
    ImportWarningKind,
    ParsedDelisting,
    ParsedRename,
    ParsedTxn,
)
from .dedup import DedupInput, dedup_hashes
from .ordering import chronological_ranks
from .reconciler import BrokerPosition
from .resolver import (
    CurrencyEvidence,
    InstrumentHint,
    InstrumentLookup,
    InstrumentMatch,
    InstrumentResolver,
    ResolvedInstrument,
)

NEEDS_INSTRUMENT: frozenset[TxnType] = frozenset(
    {
        TxnType.BUY,
        TxnType.SELL,
        TxnType.TRANSFER_IN,
        TxnType.TRANSFER_OUT,
        TxnType.SPLIT,
        TxnType.ADJUSTMENT,
    }
)
"""Types that must reference an instrument."""

NEEDS_QUANTITY: frozenset[TxnType] = frozenset(
    {TxnType.BUY, TxnType.SELL, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)
"""Types that must carry a quantity."""


def semantic_issues(txn: ParsedTxn, *, has_instrument: bool) -> list[ImportWarning]:
    """Checks shared by every importer (blocking: a commit would store broken history)."""
    name = txn.type.value
    issues: list[ImportWarning] = []
    if txn.type in NEEDS_INSTRUMENT and not has_instrument:
        issues.append(
            _blocking(
                txn.row_index, f"{name} without an instrument", ImportWarningKind.MISSING_INSTRUMENT
            )
        )
    if txn.type in NEEDS_QUANTITY and txn.quantity is None:
        issues.append(
            _blocking(
                txn.row_index, f"{name} without a quantity", ImportWarningKind.MISSING_QUANTITY
            )
        )
    if txn.type == TxnType.SPLIT and (txn.split_ratio is None or txn.split_ratio <= 0):
        issues.append(
            _blocking(
                txn.row_index,
                "split without a positive split ratio",
                ImportWarningKind.UNKNOWN_SPLIT_RATIO,
            )
        )
    if (txn.quantity is not None and txn.quantity < 0) or txn.gross_amount < 0:
        issues.append(
            _blocking(
                txn.row_index,
                "negative quantity or gross amount",
                ImportWarningKind.NEGATIVE_AMOUNT,
            )
        )
    return issues


@dataclass(frozen=True, slots=True, kw_only=True)
class PlannedRow:
    """One transaction row of a plan."""

    parsed: ParsedTxn
    txn: Transaction
    """What a commit writes: planned id, resolved (or planned) instrument id, dedup hash, and a
    ``created_at`` of ``now + chronological rank`` (re-stamp at commit, keeping the order)."""
    match: InstrumentMatch | None
    """How the instrument was found; None for rows without an instrument."""
    is_duplicate: bool
    """True when a transaction with the same dedup hash is already stored (a commit skips it)."""


@dataclass(frozen=True, slots=True, kw_only=True)
class PlannedPosition:
    parsed_index: int
    position: BrokerPosition
    match: InstrumentMatch


@dataclass(frozen=True, slots=True, kw_only=True)
class PlannedRename:
    parsed: ParsedRename
    rename: InstrumentRename


@dataclass(frozen=True, slots=True, kw_only=True)
class PlannedStatusChange:
    parsed: ParsedDelisting
    instrument_id: InstrumentId
    status: InstrumentStatus
    """``DELISTED``, or ``FROZEN`` for a frozen delisting."""


@dataclass(frozen=True, slots=True, kw_only=True)
class ImportPlan:
    """What committing a parsed file would do. Nothing is written."""

    account_id: AccountId
    broker_id: str
    """Alias namespace / batch broker label (the file's ``source`` or the importer's id)."""
    batch_id: ImportBatchId | None
    rows: tuple[PlannedRow, ...] = ()
    positions: tuple[PlannedPosition, ...] = ()
    renames: tuple[PlannedRename, ...] = ()
    status_changes: tuple[PlannedStatusChange, ...] = ()
    instruments: dict[InstrumentId, Instrument] = field(default_factory=dict)
    """Every instrument referenced (existing and planned), by id."""
    new_instruments: tuple[Instrument, ...] = ()
    """Instruments a commit creates (``needs_classification=True``)."""
    new_aliases: dict[InstrumentId, tuple[InstrumentAlias, ...]] = field(default_factory=dict)
    """Aliases a commit adds to existing instruments."""
    warnings: tuple[ImportWarning, ...] = ()
    blocking_errors: tuple[ImportWarning, ...] = ()
    account_hint: str | None = None

    @property
    def can_commit(self) -> bool:
        return not self.blocking_errors

    @property
    def new_count(self) -> int:
        return sum(1 for row in self.rows if not row.is_duplicate)

    @property
    def duplicate_count(self) -> int:
        return sum(1 for row in self.rows if row.is_duplicate)

    def transactions_to_insert(self) -> tuple[Transaction, ...]:
        """Non-duplicate transactions in chronological (``created_at``) order."""
        return tuple(
            sorted(
                (row.txn for row in self.rows if not row.is_duplicate),
                key=lambda txn: txn.created_at,
            )
        )


def _new_id() -> str:
    return str(uuid.uuid4())


def _no_existing(_hashes: Sequence[str]) -> Collection[str]:
    return ()


def plan_import(
    result: ImportParseResult,
    *,
    account_id: AccountId,
    broker_id: str,
    lookup: InstrumentLookup,
    existing_hashes: Callable[[Sequence[str]], Collection[str]] = _no_existing,
    batch_id: ImportBatchId | None = None,
    now: datetime = EPOCH,
    txn_id_factory: Callable[[], TxnId] = _new_id,
    instrument_id_factory: Callable[[], InstrumentId] = _new_id,
) -> ImportPlan:
    """Resolve, validate, hash and order ``result`` for ``account_id``.

    ``broker_id`` is the alias namespace (use ``contract.effective_broker_id(importer, result)``).
    ``existing_hashes(hashes)`` returns the subset already stored. Rows are ranked chronologically
    (R9) into ``created_at = now + rank ms``; hashes follow R8; new instruments follow R10.
    """
    warnings: list[ImportWarning] = []
    blocking: list[ImportWarning] = []
    for warning in result.warnings:
        (blocking if warning.blocking else warnings).append(warning)

    resolver = InstrumentResolver(lookup, broker_id=broker_id, id_factory=instrument_id_factory)
    seen_notes: set[str] = set()

    def add_notes(resolved: ResolvedInstrument, row: int | None) -> None:
        for note in resolved.notes:
            if note not in seen_notes:
                seen_notes.add(note)
                warnings.append(
                    ImportWarning(message=note, row=row, kind=ImportWarningKind.INSTRUMENT_NOTE)
                )

    txns = result.txns
    resolutions: list[ResolvedInstrument | None] = []
    for txn in txns:
        hint = InstrumentHint.from_txn(txn)
        resolved = None if hint.is_empty else resolver.resolve(hint)
        if resolved is not None:
            add_notes(resolved, txn.row_index)
        resolutions.append(resolved)
        blocking.extend(semantic_issues(txn, has_instrument=resolved is not None))

    hashes = dedup_hashes(
        [
            DedupInput.from_parsed(txn, None if res is None else res.instrument_id)
            for txn, res in zip(txns, resolutions, strict=True)
        ],
        account_id=account_id,
        broker_id=broker_id,
    )
    existing = set(existing_hashes(hashes)) if hashes else set()
    ranks = chronological_ranks(txns)

    rows: list[PlannedRow] = []
    for i, txn in enumerate(txns):
        resolved = resolutions[i]
        rows.append(
            PlannedRow(
                parsed=txn,
                match=None if resolved is None else resolved.match,
                is_duplicate=hashes[i] in existing,
                txn=_transaction(
                    txn,
                    txn_id=txn_id_factory(),
                    account_id=account_id,
                    instrument_id=None if resolved is None else resolved.instrument_id,
                    batch_id=batch_id,
                    dedup_hash=hashes[i],
                    created_at=now + timedelta(milliseconds=ranks[i]),
                ),
            )
        )

    positions: list[PlannedPosition] = []
    for index, position in enumerate(result.positions):
        hint = InstrumentHint.from_position(position)
        if hint.is_empty:
            warnings.append(
                ImportWarning(
                    message="Position without symbol, ISIN or name skipped",
                    kind=ImportWarningKind.MISSING_INSTRUMENT,
                )
            )
            continue
        resolved = resolver.resolve(hint)
        add_notes(resolved, None)
        positions.append(
            PlannedPosition(
                parsed_index=index,
                position=BrokerPosition.from_parsed(position, resolved.instrument_id),
                match=resolved.match,
            )
        )

    renames: list[PlannedRename] = []
    status_changes: list[PlannedStatusChange] = []
    for action in result.corporate_actions:
        match action:
            case ParsedRename():
                planned = _plan_rename(action, resolver, warnings)
                if planned is not None:
                    renames.append(planned)
            case ParsedDelisting():
                found = resolver.find(
                    symbol=action.symbol, isin=action.isin, exchange_hint=action.exchange_hint
                )
                if found is None:
                    warnings.append(
                        ImportWarning(
                            message=f"Delisting of unknown instrument {action.symbol} ignored",
                            row=action.row_index,
                            kind=ImportWarningKind.UNKNOWN_INSTRUMENT,
                        )
                    )
                    continue
                status_changes.append(
                    PlannedStatusChange(
                        parsed=action,
                        instrument_id=found.instrument_id,
                        status=InstrumentStatus.FROZEN
                        if action.frozen
                        else InstrumentStatus.DELISTED,
                    )
                )
            case _:
                warnings.append(
                    ImportWarning(
                        message=f"Unsupported corporate action {type(action).__name__} ignored",
                        row=action.row_index,
                    )
                )

    referenced: dict[InstrumentId, Instrument] = {}
    ids = [r.instrument_id for r in resolutions if r is not None]
    ids += [p.position.instrument_id for p in positions]
    ids += [i for r in renames for i in (r.rename.old_instrument_id, r.rename.new_instrument_id)]
    ids += [s.instrument_id for s in status_changes]
    for instrument_id in ids:
        instrument = resolver.instrument(instrument_id)
        if instrument is not None:
            referenced[instrument_id] = instrument

    return ImportPlan(
        account_id=account_id,
        broker_id=broker_id,
        batch_id=batch_id,
        rows=tuple(rows),
        positions=tuple(positions),
        renames=tuple(renames),
        status_changes=tuple(status_changes),
        instruments=referenced,
        new_instruments=resolver.new_instruments,
        new_aliases=resolver.new_aliases,
        warnings=tuple(warnings),
        blocking_errors=tuple(blocking),
        account_hint=result.account_hint,
    )


def _plan_rename(
    action: ParsedRename, resolver: InstrumentResolver, warnings: list[ImportWarning]
) -> PlannedRename | None:
    old = resolver.find(
        symbol=action.old_symbol, isin=action.old_isin, exchange_hint=action.exchange_hint
    )
    if old is None:
        warnings.append(
            ImportWarning(
                message=f"Rename of unknown instrument {action.old_symbol} ignored",
                row=action.row_index,
                kind=ImportWarningKind.UNKNOWN_INSTRUMENT,
            )
        )
        return None
    old_instrument = resolver.instrument(old.instrument_id)
    assert old_instrument is not None
    new = resolver.resolve(
        InstrumentHint(
            currency=old_instrument.currency,
            symbol=action.new_symbol,
            isin=action.new_isin,
            name=action.new_name or old_instrument.name,
            exchange_hint=action.new_exchange_hint or action.exchange_hint,
            evidence=CurrencyEvidence.WEAK,
        )
    )
    if new.instrument_id == old.instrument_id:
        warnings.append(
            ImportWarning(
                message=f"Rename {action.old_symbol} -> {action.new_symbol} names the same "
                "instrument; ignored",
                row=action.row_index,
                kind=ImportWarningKind.INSTRUMENT_NOTE,
            )
        )
        return None
    return PlannedRename(
        parsed=action,
        rename=InstrumentRename(
            date=action.date,
            old_instrument_id=old.instrument_id,
            new_instrument_id=new.instrument_id,
            note=action.note,
        ),
    )


def _transaction(
    txn: ParsedTxn,
    *,
    txn_id: TxnId,
    account_id: AccountId,
    instrument_id: InstrumentId | None,
    batch_id: ImportBatchId | None,
    dedup_hash: str,
    created_at: datetime,
) -> Transaction:
    return Transaction(
        id=txn_id,
        account_id=account_id,
        type=txn.type,
        trade_date=txn.trade_date,
        currency=txn.currency,
        gross_amount=txn.gross_amount.copy_abs(),
        cash_amount=txn.cash_amount,
        cash_currency=txn.cash_currency,
        instrument_id=instrument_id,
        settle_date=txn.settle_date,
        quantity=None if txn.quantity is None else txn.quantity.copy_abs(),
        price=txn.price,
        fee=txn.fee.copy_abs(),
        tax=txn.tax.copy_abs(),
        fx_rate=txn.fx_rate,
        split_ratio=txn.split_ratio,
        note=txn.note,
        source=TxnSource.IMPORT,
        import_batch_id=batch_id,
        external_ref=txn.external_ref,
        dedup_hash=dedup_hash,
        created_at=created_at,
    )


def _blocking(row: int | None, message: str, kind: str) -> ImportWarning:
    return ImportWarning(message=message, row=row, blocking=True, kind=kind)


__all__ = [
    "NEEDS_INSTRUMENT",
    "NEEDS_QUANTITY",
    "ImportPlan",
    "PlannedPosition",
    "PlannedRename",
    "PlannedRow",
    "PlannedStatusChange",
    "plan_import",
    "semantic_issues",
]
