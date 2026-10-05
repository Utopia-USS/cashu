"""Instruments and aliases (shared reference data): the DB ``InstrumentLookup`` used by import
planning, inserts of planned instruments, classification, and which instruments a profile uses.

Market identity (symbol, ISIN, currency, MIC, price aliases) is shared. The owner-editable attributes
(name, asset class, tags, region, sector, valuation mode, status, reviewed flag) are per profile: writes
go to the profile's ``inv_profile_instruments`` row, and ``load(..., profile_id=)`` returns the shared row
overlaid with it (the shared values are the defaults every profile starts from)."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import replace

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core.models import Account, utcnow

from ..domain import (
    AliasNamespace,
    AssetClass,
    Instrument,
    InstrumentAlias,
    InstrumentStatus,
    ValuationMode,
    default_valuation_mode,
)
from ..models import (
    InvAlert,
    InvDecision,
    InvInstrument,
    InvInstrumentAlias,
    InvInstrumentRename,
    InvManualValuation,
    InvPositionSnapshot,
    InvProfileInstrument,
    InvSignal,
    InvThesis,
    InvTransaction,
    InvWatchlistItem,
)
from . import convert


def _normalize(namespace: str, value: str) -> str:
    value = value.strip()
    return value.upper() if namespace == AliasNamespace.ISIN else value


def load(
    session: Session, ids: Iterable[int], *, profile_id: int | None = None
) -> dict[int, Instrument]:
    """Domain instruments (with aliases) by row key; with ``profile_id`` as that profile sees them
    (its overrides applied), without it the shared defaults (market identity code paths)."""
    wanted = sorted(set(ids))
    if not wanted:
        return {}
    rows = session.exec(select(InvInstrument).where(InvInstrument.id.in_(wanted))).all()
    aliases: dict[int, list[InvInstrumentAlias]] = {}
    for alias in session.exec(
        select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id.in_(wanted))
    ).all():
        aliases.setdefault(alias.instrument_id, []).append(alias)
    found = {row.id: convert.instrument(row, aliases.get(row.id, ())) for row in rows}
    if profile_id is not None:
        for key, override in overrides(session, profile_id, wanted).items():
            if key in found:
                found[key] = apply_override(found[key], override)
    return found


def load_one(
    session: Session, instrument_id: int, *, profile_id: int | None = None
) -> Instrument | None:
    return load(session, [instrument_id], profile_id=profile_id).get(instrument_id)


# --------------------------------------------------------------------------- #
# Per-profile overrides
# --------------------------------------------------------------------------- #


def overrides(
    session: Session, profile_id: int, ids: Iterable[int] | None = None
) -> dict[int, InvProfileInstrument]:
    query = select(InvProfileInstrument).where(InvProfileInstrument.profile_id == profile_id)
    if ids is not None:
        wanted = sorted(set(ids))
        if not wanted:
            return {}
        query = query.where(InvProfileInstrument.instrument_id.in_(wanted))
    return {row.instrument_id: row for row in session.exec(query).all()}


def apply_override(instrument: Instrument, o: InvProfileInstrument) -> Instrument:
    """``instrument`` with the profile's overrides (None = keep, "" = clear a text attribute)."""
    changes: dict[str, object] = {}
    if o.name:
        changes["name"] = o.name
    if o.asset_class:
        changes["asset_class"] = AssetClass(o.asset_class)
    if o.tags is not None:
        changes["tags"] = tuple(o.tags)
    if o.region is not None:
        changes["region"] = o.region or None
    if o.sector is not None:
        changes["sector"] = o.sector or None
    if o.valuation_mode:
        changes["valuation_mode"] = ValuationMode(o.valuation_mode)
    if o.status:
        changes["status"] = InstrumentStatus(o.status)
    if o.needs_classification is not None:
        changes["needs_classification"] = o.needs_classification
    return replace(instrument, **changes) if changes else instrument


def profile_rows(session: Session, profile_id: int, ids: Iterable[int]) -> list[InvInstrument]:
    """Detached copies of the instrument rows as ``profile_id`` sees them (for code that reads row
    attributes, e.g. the MCP owner-named check); never added to the session."""
    wanted = sorted(set(ids))
    if not wanted:
        return []
    found = overrides(session, profile_id, wanted)
    out: list[InvInstrument] = []
    for row in session.exec(select(InvInstrument).where(InvInstrument.id.in_(wanted))).all():
        copy = InvInstrument.model_validate(row.model_dump())
        o = found.get(row.id)
        if o is not None:
            if o.name:
                copy.name = o.name
            if o.asset_class:
                copy.asset_class = o.asset_class
            if o.tags is not None:
                copy.tags = list(o.tags)
            if o.region is not None:
                copy.region = o.region or None
            if o.sector is not None:
                copy.sector = o.sector or None
            if o.valuation_mode:
                copy.valuation_mode = o.valuation_mode
            if o.status:
                copy.status = o.status
            if o.needs_classification is not None:
                copy.needs_classification = o.needs_classification
        out.append(copy)
    return out


def _override_row(session: Session, profile_id: int, instrument_id: int) -> InvProfileInstrument:
    row = session.exec(
        select(InvProfileInstrument).where(
            InvProfileInstrument.profile_id == profile_id,
            InvProfileInstrument.instrument_id == instrument_id,
        )
    ).first()
    if row is None:
        row = InvProfileInstrument(profile_id=profile_id, instrument_id=instrument_id)
    return row


class DbInstrumentLookup:
    """Read-only :class:`~..importing.InstrumentLookup` over the stored instruments."""

    def __init__(self, session: Session, *, confirmed_only: bool = False) -> None:
        self._s = session
        self._confirmed_only = confirmed_only

    def _one(self, row: InvInstrument | None) -> Instrument | None:
        return None if row is None else load_one(self._s, row.id)

    def by_isin(self, isin: str) -> Instrument | None:
        wanted = isin.strip().upper()
        row = self._s.exec(
            select(InvInstrument)
            .where(func.upper(InvInstrument.isin) == wanted)
            .order_by(InvInstrument.id)
        ).first()
        if row is not None:
            return self._one(row)
        return self.by_alias(AliasNamespace.ISIN, wanted, _isin_alias_only=True)

    def by_alias(
        self, namespace: str, value: str, *, _isin_alias_only: bool = False
    ) -> Instrument | None:
        if namespace == AliasNamespace.ISIN and not _isin_alias_only:
            return self.by_isin(value)
        query = select(InvInstrumentAlias).where(
            InvInstrumentAlias.namespace == namespace,
            InvInstrumentAlias.value == _normalize(namespace, value),
        )
        if self._confirmed_only:
            query = query.where(InvInstrumentAlias.guessed == False)
        alias = self._s.exec(query).first()
        if alias is None:
            return None
        return load_one(self._s, alias.instrument_id)

    def by_symbol(self, symbol: str, mic: str) -> Sequence[Instrument]:
        rows = self._s.exec(
            select(InvInstrument)
            .where(func.upper(InvInstrument.symbol) == symbol.strip().upper())
            .where(InvInstrument.mic == mic)
            .order_by(InvInstrument.id)
        ).all()
        found = load(self._s, [r.id for r in rows])
        return [found[r.id] for r in rows]


def find_confirmed(session: Session, planned: Instrument) -> Instrument | None:
    """An already stored instrument a planned one turns out to be (concurrent previews / imports):
    same ISIN first, then any of its confirmed (never guessed) aliases."""
    lookup = DbInstrumentLookup(session, confirmed_only=True)
    if planned.isin:
        found = lookup.by_isin(planned.isin)
        if found is not None:
            return found
    for alias in planned.aliases:
        if alias.guessed:
            continue
        found = lookup.by_alias(alias.namespace, alias.value)
        if found is not None:
            return found
    return None


def insert(session: Session, planned: Instrument) -> InvInstrument:
    """Store a planned instrument and those of its aliases nobody owns yet."""
    row = InvInstrument(
        name=planned.name,
        currency=str(planned.currency),
        asset_class=planned.asset_class.value,
        symbol=planned.symbol,
        isin=planned.isin.upper() if planned.isin else None,
        mic=planned.mic,
        region=planned.region,
        sector=planned.sector,
        tags=list(planned.tags),
        needs_classification=planned.needs_classification,
        valuation_mode=(
            planned.valuation_mode or default_valuation_mode(planned.asset_class)
        ).value,
        status=planned.status.value,
    )
    session.add(row)
    session.flush()
    add_aliases(session, row, planned.aliases)
    return row


def add_aliases(
    session: Session, row: InvInstrument, aliases: Iterable[InstrumentAlias]
) -> list[InvInstrumentAlias]:
    """Add aliases (skipping those already owned by any instrument); an ISIN alias also fills the
    display ISIN when the instrument has none."""
    added: list[InvInstrumentAlias] = []
    for alias in aliases:
        value = _normalize(alias.namespace, alias.value)
        if not value:
            continue
        owner = session.exec(
            select(InvInstrumentAlias).where(
                InvInstrumentAlias.namespace == alias.namespace, InvInstrumentAlias.value == value
            )
        ).first()
        if owner is not None:
            if owner.instrument_id == row.id and owner.guessed and not alias.guessed:
                owner.guessed = False  # confirmed now
                session.add(owner)
            continue
        new = InvInstrumentAlias(
            instrument_id=row.id, namespace=alias.namespace, value=value, guessed=alias.guessed
        )
        session.add(new)
        added.append(new)
        if alias.namespace == AliasNamespace.ISIN and not row.isin:
            row.isin = value
            row.updated_at = utcnow()
            session.add(row)
    session.flush()
    return added


def set_status(
    session: Session, instrument_id: int, status: InstrumentStatus, *, profile_id: int
) -> None:
    """The instrument's status (e.g. frozen / delisted from an import) for ``profile_id`` only."""
    if session.get(InvInstrument, instrument_id) is None:
        return
    current = load_one(session, instrument_id, profile_id=profile_id)
    if current is not None and current.status == status:
        return
    row = _override_row(session, profile_id, instrument_id)
    row.status = status.value
    row.updated_at = utcnow()
    session.add(row)
    session.flush()


class ClassificationError(ValueError):
    """Invalid classification input (message safe to show)."""


def classify(
    session: Session,
    instrument_id: int,
    *,
    profile_id: int,
    asset_class: str | None = None,
    tags: Sequence[str] | None = None,
    valuation_mode: str | None = None,
    region: str | None = None,
    sector: str | None = None,
    name: str | None = None,
    status: str | None = None,
    aliases: Sequence[InstrumentAlias] = (),
    reviewed: bool = True,
) -> InvProfileInstrument:
    """Update how ``profile_id`` classifies an instrument (its override row; other profiles keep
    theirs); ``reviewed`` clears ``needs_classification`` for this profile. Aliases are market
    identity: they are added to the shared instrument (a conflict with another instrument raises)."""
    shared = session.get(InvInstrument, instrument_id)
    if shared is None:
        raise ClassificationError(f"No instrument {instrument_id}")
    current = load_one(session, instrument_id, profile_id=profile_id)
    assert current is not None
    row = _override_row(session, profile_id, instrument_id)
    try:
        if asset_class is not None:
            new_class = AssetClass(asset_class)
            if valuation_mode is None and current.valuation_mode == default_valuation_mode(
                current.asset_class
            ):
                row.valuation_mode = default_valuation_mode(new_class).value
            row.asset_class = new_class.value
        if valuation_mode is not None:
            row.valuation_mode = ValuationMode(valuation_mode).value
        if status is not None:
            row.status = InstrumentStatus(status).value
    except ValueError as e:
        raise ClassificationError(str(e)) from None
    if tags is not None:
        cleaned = [t.strip() for t in tags if t and t.strip()]
        row.tags = list(dict.fromkeys(cleaned))
    if region is not None:
        row.region = region.strip()
    if sector is not None:
        row.sector = sector.strip()
    if name is not None and name.strip():
        row.name = name.strip()
    if reviewed:
        row.needs_classification = False
    row.updated_at = utcnow()
    session.add(row)
    session.flush()
    for alias in aliases:
        value = _normalize(alias.namespace, alias.value)
        owner = session.exec(
            select(InvInstrumentAlias).where(
                InvInstrumentAlias.namespace == alias.namespace, InvInstrumentAlias.value == value
            )
        ).first()
        if owner is not None and owner.instrument_id != shared.id:
            raise ClassificationError(
                f"Alias {alias.namespace}:{value} already belongs to another instrument"
            )
    add_aliases(session, shared, [InstrumentAlias(a.namespace, a.value, False) for a in aliases])
    return row


def profile_instrument_ids(session: Session, profile_id: int) -> set[int]:
    """Every instrument the profile references (transactions, broker snapshots, renames, manual
    valuations, theses, watchlist, signals, decisions, alerts): what its instrument endpoints may show
    or change."""
    accounts = select(Account.id).where(Account.profile_id == profile_id)
    ids: set[int] = set()
    ids |= set(
        session.exec(
            select(InvTransaction.instrument_id).where(
                InvTransaction.account_id.in_(accounts), InvTransaction.instrument_id.is_not(None)
            )
        ).all()
    )
    ids |= set(
        session.exec(
            select(InvPositionSnapshot.instrument_id).where(
                InvPositionSnapshot.account_id.in_(accounts)
            )
        ).all()
    )
    for old, new in session.exec(
        select(InvInstrumentRename.old_instrument_id, InvInstrumentRename.new_instrument_id).where(
            InvInstrumentRename.profile_id == profile_id
        )
    ).all():
        ids |= {old, new}
    for model in (InvManualValuation, InvThesis, InvWatchlistItem, InvProfileInstrument):
        ids |= set(
            session.exec(select(model.instrument_id).where(model.profile_id == profile_id)).all()
        )
    for model in (InvSignal, InvDecision, InvAlert):
        query = select(model.instrument_id).where(model.profile_id == profile_id)
        if model is InvAlert:
            query = query.where(InvAlert.deleted_at.is_(None))  # soft-deleted (F6)
        ids |= {i for i in session.exec(query).all() if i is not None}
    return ids
