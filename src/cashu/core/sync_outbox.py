"""Sync outbox (S30): every write of the Python app to a synced table, as field-level changes.

TRANSITIONAL(S49): the strangler bridge between the Python app (the writer today) and the event log
(``packages/store``). The shipper (S31a) reads ``sync_outbox`` in id order, maps the rows of one
transaction (``txn``) to one batch of catalog events (``packages/store/spec/events.md`` 8), appends
them through the carrier and acks the rows; only acked rows are ever pruned.

Gated by ``CASHU_SYNC=1``. With the flag off nothing is captured and nothing is written; but once a
profile is linked to a vault (``sync_vaults`` has a row), a write to a synced table without the flag
fails (``SyncCaptureError``, S31a P-D): it would leave no outbox row and fork the database from the log.
With the flag on, a capture failure fails the write (fail closed: a silently lost change would make
the devices diverge).

What is captured (hooks in ``core/events.py``):

- ORM flushes: an insert records every synced column, an update the changed synced columns (attribute
  history: new values in ``fields``, previous ones in ``prev``), a delete the row's last state. Inserts
  and updates also carry ``post``, the whole row after the change as stored (derived columns and
  ``updated_at`` included; S31a P-B): the shipper stamps events with the row's own timestamps from it. Derived
  columns (events.md 9) and ``updated_at`` (the outbox ``ts`` is the domain time) are never captured;
  derived rows (cash mirror legs) neither. A row inserted and deleted in one transaction leaves nothing.
- Bulk ORM ``update()`` / ``delete()`` of a synced table: the affected rows are read before (and, for
  an update, after) the statement and recorded one by one. A bulk ORM ``insert()`` into a synced table
  is refused while the flag is on (no site does it; it could not be captured row by row).
- Explicit emits (:func:`emit_row`, :func:`emit`) where a generic row change would misstate the intent:
  instrument merge (raw SQL, ``merge``), decision and review undo (``undo``), deleting a cash mirror
  leg (``leg_delete``). Every raw-SQL writer to a synced table must emit; ``tests/test_sync_outbox.py``
  fails on a new one.

Profiles: every row carries the profile (vault) it belongs to, read from ``profile_id`` or through the
account / decision it hangs off; instruments and aliases are shared today (``profile_id`` NULL) and
the shipper fans them out to the vaults that reference them (D3).

Gids: ``gid`` is filled when Python knows it for good: a ULID minted here for a ULID-table insert, a DET
gid over plain parts when the vault's salt is in the keychain (``core/sync_keys.py``) and every
referenced gid is known, the profile's vault id for ``profiles``, or an earlier mapping in ``sync_ids``
(genesis seed, an earlier mint, an ack). Otherwise it is NULL and ``key`` carries the DET parts in local
form (columns, referenced local ids), so the shipper computes the gid with the shared TS mappers
(gid.md 4, ``det-parts.ts``) and returns it with the ack (:func:`ack`).
"""

from __future__ import annotations

import datetime as dt
import enum
import json
import re
import uuid
import weakref
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import JSON, Integer, and_, delete, func, insert, inspect, or_, select, update
from sqlalchemy.orm import object_mapper
from sqlalchemy.sql import ClauseElement

from . import sync_keys
from .env import env
from .models import utcnow
from .sync_models import SyncClock, SyncId, SyncOutbox, SyncVault

ENV_FLAG = "SYNC"
OUTBOX = SyncOutbox.__table__
IDS = SyncId.__table__
VAULTS = SyncVault.__table__
CLOCKS = SyncClock.__table__
STATE_KEY = "cashu.sync_outbox"
GUARD_KEY = "cashu.sync_guard"  # flag off: is a vault linked? (cached per root transaction, _guard)
ORIGINS = ("local", "inbound")
EXPLICIT_OPS = ("merge", "undo", "leg_delete")
GLOBAL_DERIVED = frozenset({"updated_at"})
CLAIM_SOURCES = frozenset({"manual_txn", "llm_full", "llm_fallback"})


class SyncCaptureError(RuntimeError):
    """A write to a synced table that the outbox cannot record (fails the write while the flag is on)."""


def enabled() -> bool:
    return env(ENV_FLAG) == "1"


# --------------------------------------------------------------------------- #
# What syncs
# --------------------------------------------------------------------------- #

Part = tuple[str, ...]
"""A DET part: ``("col", column)``, ``("date", column)`` or ``("ref", column, referenced table)``."""


@dataclass(frozen=True)
class Spec:
    gid: str
    """``ulid`` (minted here), ``det`` (plain parts below), ``shipper`` (computed by the shipper; some
    rows minted, see ``mint``), ``vault`` (the profile's vault id) or ``none`` (embedded in another
    table's events)."""
    profile: str
    """``column`` (``profile_id``), ``self`` (``profiles``), ``account``, ``decision`` or ``global``."""
    derived: frozenset[str] = frozenset()
    parts: tuple[Part, ...] = ()
    key: tuple[str, ...] = ()
    """Columns snapshotted into ``key`` on every row (DET parts in local form)."""
    skip_row: Callable[[dict], bool] | None = None
    """True for a derived row (never captured)."""
    mint: Callable[[dict], bool] | None = None
    """For ``shipper`` tables: rows whose gid is a ULID Python mints (cash expenses, manual entries)."""
    filter_fields: Callable[[str, dict, dict | None, dict], None] | None = None
    """``(op, fields, prev, row)``: drops derived value changes in place."""
    det_table: str | None = None
    """The gid domain when it differs from the table name."""


def _parked(value: Any, row: dict) -> bool:
    return isinstance(value, str) and row.get("id") is not None and value.endswith(f"~{row['id']}")


def _accounts_filter(op: str, fields: dict, prev: dict | None, row: dict) -> None:
    """Key parking (``<key>~<id>``) is derived in the view (gid.md 4.3): parking and un-parking are not
    captured."""
    if "external_id" in fields and (
        _parked(row.get("external_id"), row) or (prev and _parked(prev.get("external_id"), row))
    ):
        fields.pop("external_id", None)
        if prev:
            prev.pop("external_id", None)


def _txn_filter(op: str, fields: dict, prev: dict | None, row: dict) -> None:
    """A category is a synced claim only for the claim sources (events.md 8.3, D8); rule, keyword,
    default and engine categories are derived on every device. A change away from a claim stays (the
    shipper maps it to ``txn.categoryCleared``)."""
    new = row.get("category_source")
    old = (prev or {}).get("category_source", new)
    if new in CLAIM_SOURCES or (op == "update" and old in CLAIM_SOURCES):
        if op == "update" and "category" in fields and "category_source" not in fields:
            fields["category_source"] = _plain(new)  # the claim the new category belongs to
        return
    for col in ("category", "category_source"):
        fields.pop(col, None)
        if prev:
            prev.pop(col, None)


def _signal_filter(op: str, fields: dict, prev: dict | None, row: dict) -> None:
    """``acknowledged`` is derived from decisions (events.md 6.5): active <-> acknowledged is not
    captured; every other status change is (closed, reopened). ``prev["status"]`` stays (evidence only,
    never shipped): the shipper derives ``signal.escalated {reactivate}`` from an escalation whose
    previous status was ``acknowledged`` (S31a P-C). A row whose only change was this status is still
    dropped (no fields)."""
    if op != "update" or "status" not in fields:
        return
    pair = {fields["status"], (prev or {}).get("status")}
    if pair <= {"active", "acknowledged"}:
        fields.pop("status")


def _proposal_filter(op: str, fields: dict, prev: dict | None, row: dict) -> None:
    """``applying`` is a device-local lock (events.md 10)."""
    if fields.get("status") == "applying":
        fields.pop("status")
        if prev:
            prev.pop("status", None)


def _cash_leg(row: dict) -> bool:
    return str(row.get("dedup_hash") or "").startswith("cashleg:")


def _account_det(*more: Part) -> tuple[Part, ...]:
    return (("ref", "account_id", "accounts"), *more)


_INSTRUMENT_REF: Part = ("ref", "instrument_id", "inv_instruments")

SPECS: dict[str, Spec] = {
    "profiles": Spec("vault", "self"),
    "profile_modules": Spec(
        "det", "column", frozenset({"enabled_at"}), (("col", "module_id"),), ("module_id",)
    ),
    "accounts": Spec(
        "shipper",
        "column",
        key=("bank", "iban", "external_id"),
        filter_fields=_accounts_filter,
    ),
    "balances": Spec(
        "det",
        "account",
        parts=_account_det(("date", "date"), ("col", "source")),
        key=("account_id", "date", "source"),
    ),
    "transactions": Spec(
        "shipper",
        "account",
        frozenset({"is_internal_transfer", "transfer_group_id"}),
        key=(
            "account_id",
            "booking_date",
            "amount",
            "currency",
            "counterparty_name",
            "counterparty_iban",
            "description",
            "reference",
            "dedup_hash",
            "occurrence",
        ),
        skip_row=_cash_leg,
        mint=lambda row: str(row.get("dedup_hash") or "").startswith("cashexp:"),
        filter_fields=_txn_filter,
    ),
    "category_rules": Spec(
        "det", "column", parts=(("col", "merchant_key"),), key=("merchant_key",)
    ),
    "import_batches": Spec("ulid", "column"),
    "loans": Spec("det", "account", parts=_account_det(), key=("account_id",)),
    "depreciations": Spec("det", "account", parts=_account_det(), key=("account_id",)),
    "asset_details": Spec("det", "account", parts=_account_det(), key=("account_id",)),
    "inv_account_settings": Spec("det", "account", parts=_account_det(), key=("account_id",)),
    "inv_import_batches": Spec("ulid", "column"),
    "inv_transactions": Spec(
        "shipper",
        "account",
        key=("account_id", "instrument_id", "import_batch_id", "source", "dedup_hash"),
        mint=lambda row: row.get("source") == "manual",
    ),
    "inv_position_snapshots": Spec(
        "det",
        "account",
        parts=_account_det(_INSTRUMENT_REF, ("date", "as_of")),
        key=("account_id", "instrument_id", "as_of"),
    ),
    "inv_instrument_renames": Spec(
        "det",
        "column",
        parts=(
            ("date", "date"),
            ("ref", "old_instrument_id", "inv_instruments"),
            ("ref", "new_instrument_id", "inv_instruments"),
        ),
        key=("date", "old_instrument_id", "new_instrument_id"),
    ),
    "inv_manual_valuations": Spec(
        "det", "column", parts=(_INSTRUMENT_REF, ("date", "as_of")), key=("instrument_id", "as_of")
    ),
    "inv_instruments": Spec("shipper", "global", key=("isin", "symbol")),
    "inv_instrument_aliases": Spec(
        "shipper", "global", key=("instrument_id", "namespace", "value")
    ),
    "inv_profile_instruments": Spec(
        "det", "column", frozenset({"plan_at"}), (_INSTRUMENT_REF,), ("instrument_id",)
    ),
    "inv_strategy_versions": Spec("ulid", "column", frozenset({"version"})),
    "inv_theses": Spec("ulid", "column", frozenset({"core_changed_at", "exit_plan_changed_at"})),
    "inv_topic_theses": Spec(
        "det",
        "column",
        frozenset({"core_changed_at", "view_updated_at"}),
        (("col", "segment"),),
        ("segment",),
    ),
    "watchlist_items": Spec(
        "det", "column", frozenset({"added_at"}), (_INSTRUMENT_REF,), ("instrument_id",)
    ),
    "alerts": Spec("ulid", "column"),
    "inv_planned_deposits": Spec("ulid", "column"),
    "inv_signals": Spec(
        "ulid", "column", frozenset({"acknowledged_at"}), filter_fields=_signal_filter
    ),
    "inv_rule_runs": Spec("ulid", "column"),
    "inv_decisions": Spec("ulid", "column", frozenset({"signal_id"})),
    "inv_decision_signals": Spec("none", "decision", key=("decision_id", "signal_id")),
    "reviews": Spec("ulid", "column"),
    "proposals": Spec("ulid", "column", filter_fields=_proposal_filter),
    "research_runs": Spec("ulid", "column"),
    "research_notes": Spec("ulid", "column"),
    "connector_bindings": Spec(
        "det",
        "column",
        frozenset({"last_run_at", "last_status", "last_ok_at", "backoff_until"}),
        (("ref", "account_id", "accounts"), ("col", "connector_id")),
        ("account_id", "connector_id"),
    ),
}
"""Every synced table (events.md 8.1). A table is in exactly one of ``SPECS`` and ``NOT_SYNCED``."""

NOT_SYNCED: dict[str, str] = {
    "change_events": "replaced by store subscriptions (events.md 10)",
    "mcp_calls": "per-device audit (D6)",
    "inv_notification_log": "each device notifies itself",
    "connectors": "code + approval is a per-machine security act (D7)",
    "connector_runs": "per-device run log (D7)",
    "inv_price_bars": "refetchable cache (D4)",
    "inv_fx_rates": "refetchable cache (D4)",
    "inv_macro_bars": "refetchable cache (D4)",
    "sync_outbox": "the outbox itself",
    "sync_ids": "device-local id map",
    "sync_vaults": "device-local vault link",
    "sync_inbound": "device-local record of applied inbound events (S31b)",
    "sync_clock": "device-local field clocks of inbound writes (S31b)",
}


def synced_tables() -> frozenset[str]:
    return frozenset(SPECS)


# --------------------------------------------------------------------------- #
# Transaction state (one per root session transaction)
# --------------------------------------------------------------------------- #


@dataclass
class _State:
    txn: str = field(default_factory=lambda: uuid.uuid4().hex)
    origin: str = "local"
    bind: dict[str, str] = field(default_factory=dict)
    inserted: set[tuple[str, str]] = field(default_factory=set)
    covered: set[tuple[str, str]] = field(default_factory=set)
    profiles: dict[tuple[str, str], int | None] = field(default_factory=dict)
    gids: dict[tuple[int, str, str], str | None] = field(default_factory=dict)
    salts: dict[int, sync_keys.Salt | None] = field(default_factory=dict)


def _state(session) -> _State:
    st = session.info.get(STATE_KEY)
    if st is None:
        st = session.info[STATE_KEY] = _State()
    return st


def reset(session) -> None:
    """Forget the transaction state (the root transaction ended: commit or rollback)."""
    session.info.pop(STATE_KEY, None)
    session.info.pop(GUARD_KEY, None)


def _guard(session) -> None:
    """Fail closed while the flag is off (S31a P-D): once a profile is linked to a vault, a write to a
    synced table without ``CASHU_SYNC=1`` would leave no outbox row, and the database would silently
    fork from the event log. Raises ``SyncCaptureError`` when ``sync_vaults`` has a row.

    Cost: only for a flush / bulk statement that touches a synced table with the flag off; one
    ``SELECT ... LIMIT 1`` on ``sync_vaults`` (a handful of rows) per root transaction, cached in
    ``session.info`` until the transaction ends (:func:`reset`); before the sync tables exist (an old
    schema mid-upgrade) one cached ``has_table`` instead. Flag off and no vault linked: nothing else
    changes."""
    linked = session.info.get(GUARD_KEY)
    if linked is None:
        conn = session.connection()
        linked = _tables_ready(conn) and conn.execute(select(VAULTS.c.profile_id).limit(1)).first() is not None
        session.info[GUARD_KEY] = linked
    if linked:
        raise SyncCaptureError("a linked vault needs CASHU_SYNC=1")


@contextmanager
def inbound(session, bind: dict[str, str] | None = None) -> Iterator[None]:
    """Rows captured inside are tagged ``origin = inbound`` and recorded already acked: S31b applies
    events of other devices through the services, and the shipper must never ship them back (no echo;
    ``pending`` never returns them). ``bind``: table -> gid of the row the inbound event creates (a
    decision, a review, a rule), used instead of a freshly minted or computed gid."""
    st = _state(session)
    before = st.origin, st.bind
    st.origin, st.bind = "inbound", dict(bind or {})
    try:
        yield
    finally:
        st.origin, st.bind = before


_ready: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _tables_ready(conn) -> bool:
    engine = conn.engine
    if _ready.get(engine):
        return True
    ok = inspect(conn).has_table(OUTBOX.name)
    if ok:
        _ready[engine] = True
    return ok


# --------------------------------------------------------------------------- #
# Values
# --------------------------------------------------------------------------- #

_encoders: dict[tuple[int, str], Callable[[Any], Any]] = {}


def _plain(value: Any) -> Any:
    """A JSON-safe value of a JSON column or a part (no DB processing)."""
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    if isinstance(value, dt.datetime | dt.date):
        return value.isoformat()
    return str(value)


def _is_json(column) -> bool:
    typ = column.type
    return isinstance(typ, JSON) or isinstance(getattr(typ, "impl", None), JSON)


def _pk_bind(column, value: Any, dialect) -> Any:
    """A primary key value as the driver binds it (the column's bind processor)."""
    proc = column.type.dialect_impl(dialect).bind_processor(dialect)
    return proc(value) if proc is not None else value


def _encoder(column, dialect) -> Callable[[Any], Any]:
    """The column's value as SQLite stores it (the same text genesis reads from the database)."""
    k = (id(column), dialect.name)
    enc = _encoders.get(k)
    if enc is not None:
        return enc
    typ = column.type
    if isinstance(typ, JSON) or isinstance(getattr(typ, "impl", None), JSON):
        enc = _plain
    else:
        proc = typ.dialect_impl(dialect).bind_processor(dialect)

        def enc(value, _proc=proc):
            if value is None:
                return None
            out = _proc(value) if _proc is not None else value
            return _plain(out)

    _encoders[k] = enc
    return enc


def _synced_columns(table_name: str, table) -> list:
    spec = SPECS[table_name]
    skip = spec.derived | GLOBAL_DERIVED
    return [c for c in table.columns if c.name not in skip]


def _local_id(table, row: dict) -> str:
    return "|".join(str(row.get(c.name)) for c in table.primary_key.columns)


def _row_of(obj) -> dict:
    """Column values of an ORM object without loading anything (``state.dict``)."""
    state = inspect(obj)
    mapper = state.mapper
    out: dict = {}
    for prop in mapper.column_attrs:
        if prop.key in state.dict:
            out[prop.columns[0].name] = state.dict[prop.key]
    return out


# --------------------------------------------------------------------------- #
# Profiles and gids
# --------------------------------------------------------------------------- #

_PARENT = {"account": ("accounts", "account_id"), "decision": ("inv_decisions", "decision_id")}


def _profile_of(conn, st: _State, table_name: str, row: dict, metadata) -> int | None:
    how = SPECS[table_name].profile
    if how == "column":
        return row.get("profile_id")
    if how == "self":
        return row.get("id")
    if how == "global":
        return None
    parent, column = _PARENT[how]
    ref = row.get(column)
    if ref is None:
        return None
    k = (parent, str(ref))
    if k not in st.profiles:
        t = metadata.tables[parent]
        st.profiles[k] = conn.execute(select(t.c.profile_id).where(t.c.id == ref)).scalar()
    return st.profiles[k]


def _vault_of(conn, profile_id: int) -> str | None:
    return conn.execute(
        select(VAULTS.c.vault_id).where(VAULTS.c.profile_id == profile_id)
    ).scalar()


def _salt(conn, st: _State, profile_id: int) -> sync_keys.Salt | None:
    if profile_id not in st.salts:
        vault = _vault_of(conn, profile_id)
        st.salts[profile_id] = sync_keys.gid_salt(vault) if vault else None
    return st.salts[profile_id]


def _known_gid(conn, st: _State, profile_id: int | None, table_name: str, local_id: str) -> str | None:
    if profile_id is None:
        return None
    k = (profile_id, table_name, local_id)
    if k not in st.gids:
        st.gids[k] = conn.execute(
            select(IDS.c.gid).where(
                IDS.c.profile_id == profile_id,
                IDS.c.table_name == table_name,
                IDS.c.local_id == local_id,
            )
        ).scalar()
    return st.gids[k]


def _row_gid(conn, st: _State, table_name: str, profile_id: int | None, local_id: str) -> str | None:
    """The gid of an existing row: the vault id for ``profiles``, else the ``sync_ids`` mapping."""
    if SPECS[table_name].gid == "vault":
        return _vault_of(conn, profile_id) if profile_id is not None else None
    return _known_gid(conn, st, profile_id, table_name, local_id)


def _det_gid(conn, st: _State, table_name: str, row: dict, profile_id: int | None) -> str | None:
    spec = SPECS[table_name]
    if profile_id is None or not spec.parts:
        return None
    salt = _salt(conn, st, profile_id)
    if salt is None:
        return None
    parts: list[str] = []
    for part in spec.parts:
        value = row.get(part[1])
        if value is None:
            return None
        if part[0] == "ref":
            ref = _known_gid(conn, st, profile_id, part[2], str(value))
            if ref is None:
                return None
            parts.append(ref)
        elif part[0] == "date":
            parts.append(value.isoformat() if isinstance(value, dt.date) else str(value)[:10])
        else:
            # An enum member is its catalog value, as genesis decodes the stored NAME ("MANUAL" ->
            # "manual"): str() of a str-mixin member gives "Source.MANUAL" (S31a: Python's DET gid of
            # a manual balance differed from the one TS checks).
            parts.append(str(value.value if isinstance(value, enum.Enum) else value))
    return sync_keys.det_gid(salt, spec.det_table or table_name, parts)


def _new_gid(conn, st: _State, table_name: str, row: dict, profile_id: int | None) -> tuple[str | None, str]:
    spec = SPECS[table_name]
    if st.origin == "inbound" and table_name in st.bind and profile_id is not None:
        return st.bind.pop(table_name), "inbound"
    if spec.gid == "ulid" or (spec.gid == "shipper" and spec.mint and spec.mint(row)):
        return (sync_keys.mint_ulid() if profile_id is not None else None), "minted"
    if spec.gid == "det":
        return _det_gid(conn, st, table_name, row, profile_id), "det"
    if spec.gid == "vault" and profile_id is not None:
        return _vault_of(conn, profile_id), "vault"
    return None, ""


def _set_gid(conn, st: _State, profile_id: int | None, table_name: str, local_id: str, gid: str | None, source: str) -> None:
    """Map a freshly inserted row: a rowid SQLite reuses after a delete must never keep an old gid."""
    if profile_id is None:
        conn.execute(delete(IDS).where(IDS.c.table_name == table_name, IDS.c.local_id == local_id))
        return
    conn.execute(
        delete(IDS).where(
            IDS.c.profile_id == profile_id, IDS.c.table_name == table_name, IDS.c.local_id == local_id
        )
    )
    st.gids[(profile_id, table_name, local_id)] = gid
    if gid is not None and source in ("minted", "det", "inbound"):
        # OR IGNORE: a gid another local row already holds (a duplicate Python kept) stays with that
        # row; this one's later changes carry their key and the shipper resolves them.
        conn.execute(
            insert(IDS).prefix_with("OR IGNORE").values(
                profile_id=profile_id, table_name=table_name, local_id=local_id, gid=gid, source=source
            )
        )


def _drop_gid(conn, st: _State, profile_id: int | None, table_name: str, local_id: str) -> None:
    where = [IDS.c.table_name == table_name, IDS.c.local_id == local_id]
    if profile_id is not None:
        where.append(IDS.c.profile_id == profile_id)
        st.gids.pop((profile_id, table_name, local_id), None)
    conn.execute(delete(IDS).where(*where))


# --------------------------------------------------------------------------- #
# Capture
# --------------------------------------------------------------------------- #


def _outbox_row(st: _State, *, profile_id, table_name, op, local_id, gid, fields, prev=None, key=None, post=None) -> dict:
    return {
        "ts": utcnow(),
        "txn": st.txn,
        "profile_id": profile_id,
        "table_name": table_name,
        "op": op,
        "local_id": local_id,
        "gid": gid,
        "fields": fields,
        "prev": prev,
        "key": key,
        "origin": st.origin,
        "acked_at": utcnow() if st.origin == "inbound" else None,  # never shipped back (S31b)
        "post": post,
    }


def _key(table_name: str, table, row: dict, dialect) -> dict | None:
    cols = SPECS[table_name].key
    if not cols:
        return None
    return {c: _encoder(table.c[c], dialect)(row.get(c)) for c in cols if c in table.c}


def _full_fields(table_name: str, table, row: dict, dialect) -> dict:
    return {c.name: _encoder(c, dialect)(row.get(c.name)) for c in _synced_columns(table_name, table) if c.name in row}


class _Capture:
    """One flush or bulk statement worth of outbox rows."""

    def __init__(self, session, conn) -> None:
        self.session = session
        self.conn = conn
        self.st = _state(session)
        self.dialect = conn.dialect
        self.rows: list[dict] = []

    def post(self, table, row: dict) -> dict:
        """The whole row after an insert / update as stored (S31a P-B): every column but
        ``profile_id``, derived and excluded ones included. Read back from the row itself, at the
        driver level, so every value is what SQLite holds (its type affinity applied: a NUMERIC column
        bound as ``"95000.0"`` is stored as the integer 95000, which genesis reads) and not the bound
        value; JSON columns are parsed. Falls back to the flushed object's state when the row cannot
        be read (it has no primary key value)."""
        pk = list(table.primary_key.columns)
        stored = None
        if all(row.get(c.name) is not None for c in pk):
            where = " AND ".join(f'"{c.name}" = ?' for c in pk)
            params = tuple(_pk_bind(c, row[c.name], self.dialect) for c in pk)
            stored = (
                self.conn.exec_driver_sql(f'SELECT * FROM "{table.name}" WHERE {where}', params)
                .mappings()
                .first()
            )
        if stored is None:
            return {
                c.name: _encoder(c, self.dialect)(row.get(c.name))
                for c in table.columns
                if c.name != "profile_id"
            }
        out: dict = {}
        for c in table.columns:
            if c.name == "profile_id":
                continue
            value = stored.get(c.name)
            if _is_json(c) and isinstance(value, str):
                value = json.loads(value)
            out[c.name] = value
        return out

    def insert(self, table, row: dict) -> None:
        name = table.name
        spec = SPECS[name]
        if spec.skip_row and spec.skip_row(row):
            return
        local_id = _local_id(table, row)
        pid = _profile_of(self.conn, self.st, name, row, table.metadata)
        fields = _full_fields(name, table, row, self.dialect)
        if spec.filter_fields:
            spec.filter_fields("insert", fields, None, row)
        gid, source = _new_gid(self.conn, self.st, name, row, pid)
        if spec.gid != "none":
            _set_gid(self.conn, self.st, pid, name, local_id, gid, source)
        self.st.inserted.add((name, local_id))
        self.rows.append(
            _outbox_row(
                self.st,
                profile_id=pid,
                table_name=name,
                op="insert",
                local_id=local_id,
                gid=gid,
                fields=fields,
                key=_key(name, table, row, self.dialect),
                post=self.post(table, row),
            )
        )

    def update(self, table, row: dict, changes: dict[str, tuple[Any, Any, bool]]) -> None:
        """``changes``: column -> (old, new, old known)."""
        name = table.name
        spec = SPECS[name]
        if spec.skip_row and spec.skip_row(row):
            return
        synced = {c.name: c for c in _synced_columns(name, table)}
        fields: dict = {}
        prev: dict = {}
        for col, (old, new, known) in changes.items():
            if col not in synced:
                continue
            enc = _encoder(synced[col], self.dialect)
            fields[col] = enc(new)
            if known:
                prev[col] = enc(old)
        if spec.filter_fields and fields:
            spec.filter_fields("update", fields, prev, row)
        if not fields:
            return
        local_id = _local_id(table, row)
        pid = _profile_of(self.conn, self.st, name, row, table.metadata)
        self.rows.append(
            _outbox_row(
                self.st,
                profile_id=pid,
                table_name=name,
                op="update",
                local_id=local_id,
                gid=_row_gid(self.conn, self.st, name, pid, local_id),
                fields=fields,
                prev=prev or None,
                key=_key(name, table, row, self.dialect),
                post=self.post(table, row),
            )
        )

    def delete(self, table, row: dict) -> None:
        name = table.name
        spec = SPECS[name]
        if spec.skip_row and spec.skip_row(row):
            return
        local_id = _local_id(table, row)
        pid = _profile_of(self.conn, self.st, name, row, table.metadata)
        k = (name, local_id)
        if k in self.st.inserted:  # created and dropped in one transaction: nothing happened
            self.flush_rows()
            self.conn.execute(
                delete(OUTBOX).where(
                    OUTBOX.c.txn == self.st.txn,
                    OUTBOX.c.table_name == name,
                    OUTBOX.c.local_id == local_id,
                )
            )
            self.st.inserted.discard(k)
            _drop_gid(self.conn, self.st, pid, name, local_id)
            return
        gid = _row_gid(self.conn, self.st, name, pid, local_id)
        if spec.gid != "none":
            _drop_gid(self.conn, self.st, pid, name, local_id)
        if k in self.st.covered:  # an explicit emit stands for it
            return
        self.rows.append(
            _outbox_row(
                self.st,
                profile_id=pid,
                table_name=name,
                op="delete",
                local_id=local_id,
                gid=gid,
                fields=_full_fields(name, table, row, self.dialect),
                key=_key(name, table, row, self.dialect),
            )
        )

    def flush_rows(self) -> None:
        if self.rows:
            self.conn.execute(insert(OUTBOX), self.rows)
            self.rows = []


def _order(metadata) -> dict[str, int]:
    return {t.name: i for i, t in enumerate(metadata.sorted_tables)}


def _sort_key(order: dict[str, int], reverse: bool) -> Callable[[Any], tuple]:
    """Parents before children (deletes: children first), then by primary key."""

    def key(obj) -> tuple:
        table = object_mapper(obj).local_table
        rank = order.get(table.name, 0)
        row = _row_of(obj)
        pk = tuple(_pk_sort(row.get(c.name)) for c in table.primary_key.columns)
        return (-rank if reverse else rank, pk)

    return key


def _pk_sort(value: Any) -> tuple:
    return (0, value, "") if isinstance(value, int) else (1, 0, str(value))


def prepare_flush(session) -> None:
    """``before_flush``: load the expired columns of changed and deleted synced rows while they still
    exist (an object kept across a commit is expired; setting one attribute does not load the others),
    so the capture sees the profile, the key columns and a delete's last state. With the flag off it
    only runs the linked-vault guard (:func:`_guard`), before any SQL of the flush."""
    if not enabled():
        if any(_table_of(o) in SPECS for o in (*session.new, *session.dirty, *session.deleted)):
            _guard(session)
        return
    for obj in (*session.new, *session.dirty):
        if _table_of(obj) in SPECS:
            _refuse_sql_expressions(obj)
    for obj in (*session.dirty, *session.deleted):
        if _table_of(obj) not in SPECS:
            continue
        state = inspect(obj)
        if state.key is None:
            continue
        for prop in state.mapper.column_attrs:
            if prop.key not in state.dict:
                getattr(obj, prop.key)  # loads every expired column in one SELECT


def _refuse_sql_expressions(obj) -> None:
    """Fail closed (S31a F3): a column set to a SQL expression (``row.n = Table.n + 1``) is computed by
    SQLite and expired by the flush, so the capture would see no history and no value: the change
    would reach the database but never the log. Refused before any SQL; assign the value instead."""
    state = inspect(obj)
    for prop in state.mapper.column_attrs:
        if isinstance(state.dict.get(prop.key), ClauseElement):
            raise SyncCaptureError(
                f"{_table_of(obj)}.{prop.columns[0].name} is set to a SQL expression, which the sync "
                "outbox cannot capture; assign the computed value"
            )


def capture_flush(session) -> None:
    """``after_flush``: record the flush's inserts, updates and deletes of synced tables."""
    if not enabled():
        return
    objs = [o for o in (*session.new, *session.dirty, *session.deleted) if _table_of(o) in SPECS]
    if not objs:
        return
    conn = session.connection()
    if not _tables_ready(conn):
        return
    cap = _Capture(session, conn)
    metadata = object_mapper(objs[0]).local_table.metadata
    order = _order(metadata)
    for obj in objs:  # parents of this flush: their profile even when they are deleted with the child
        name = _table_of(obj)
        if name in ("accounts", "inv_decisions"):
            row = _row_of(obj)
            if row.get("id") is not None:
                cap.st.profiles[(name, str(row["id"]))] = row.get("profile_id")
    for obj in sorted((o for o in session.new if _table_of(o) in SPECS), key=_sort_key(order, False)):
        cap.insert(object_mapper(obj).local_table, _row_of(obj))
    for obj in sorted((o for o in session.dirty if _table_of(o) in SPECS), key=_sort_key(order, False)):
        changes = _history(obj)
        if changes:
            cap.update(object_mapper(obj).local_table, _row_of(obj), changes)
    for obj in sorted((o for o in session.deleted if _table_of(o) in SPECS), key=_sort_key(order, True)):
        cap.delete(object_mapper(obj).local_table, _row_of(obj))
    cap.flush_rows()


def _table_of(obj) -> str | None:
    return getattr(obj, "__tablename__", None)


def _history(obj) -> dict[str, tuple[Any, Any, bool]]:
    state = inspect(obj)
    out: dict[str, tuple[Any, Any, bool]] = {}
    for prop in state.mapper.column_attrs:
        hist = state.attrs[prop.key].history
        if not hist.added:
            continue
        new = hist.added[0]
        known = bool(hist.deleted)
        old = hist.deleted[0] if known else None
        if known and old == new:
            continue
        out[prop.columns[0].name] = (old, new, known)
    return out


def capture_bulk(state) -> Any:
    """``do_orm_execute`` of a bulk ``update()`` / ``delete()`` on a synced table: read the affected
    rows, run the statement, record each row. Returns the statement's result (or None when the
    statement is not one to capture, so SQLAlchemy runs it normally). With the flag off only the
    linked-vault guard runs (:func:`_guard`)."""
    if not (state.is_update or state.is_delete or state.is_insert):
        return None
    statement = state.statement
    table = getattr(statement, "table", None)
    name = getattr(table, "name", None)
    if name not in SPECS:
        return None
    if not enabled():
        _guard(state.session)
        return None
    session = state.session
    conn = session.connection()
    if not _tables_ready(conn):
        return None
    if state.is_insert:
        raise SyncCaptureError(
            f"bulk insert into the synced table {name} cannot be captured by the sync outbox; "
            "add the rows through the session"
        )
    where = statement.whereclause
    pk = list(table.primary_key.columns)
    query = select(table) if where is None else select(table).where(where)
    before = [dict(r._mapping) for r in conn.execute(query)]
    result = state.invoke_statement()
    cap = _Capture(session, conn)
    if state.is_delete:
        for row in before:
            cap.delete(table, row)
    else:
        for row in before:
            current = conn.execute(select(table).where(and_(*(c == row[c.name] for c in pk)))).first()
            if current is None:
                continue
            after = dict(current._mapping)
            changes = {
                c: (row[c], after[c], True) for c in after if c in row and after[c] != row[c]
            }
            if changes:
                cap.update(table, after, changes)
    cap.flush_rows()
    return result


# --------------------------------------------------------------------------- #
# Explicit emits
# --------------------------------------------------------------------------- #


def emit_row(session, obj, op: str, *, fields: dict | None = None, covers: Iterable[tuple[str, str]] = ()) -> None:
    """Record the explicit ``op`` for an ORM row (before it is deleted) and suppress the generic
    capture of the row's delete and of ``covers`` in this transaction: ``undo`` of a decision or a
    review, ``leg_delete`` of a cash mirror leg."""
    if not enabled():
        _guard(session)
        return
    if op not in EXPLICIT_OPS:
        raise ValueError(f"unknown explicit op {op!r}")
    conn = session.connection()
    if not _tables_ready(conn):
        return
    st = _state(session)
    table = object_mapper(obj).local_table
    name = table.name
    row = _row_of(obj)
    local_id = _local_id(table, row)
    pid = _profile_of(conn, st, name, row, table.metadata)
    st.covered.add((name, local_id))
    st.covered.update(covers)
    conn.execute(
        insert(OUTBOX),
        [
            _outbox_row(
                st,
                profile_id=pid,
                table_name=name,
                op=op,
                local_id=local_id,
                gid=_row_gid(conn, st, name, pid, local_id),
                fields=_plain(fields or {}),
                key=_key(name, table, row, conn.dialect),
            )
        ],
    )


def emit(session, table_name: str, op: str, local_id: str, *, profile_id: int | None = None, fields: dict | None = None, key: dict | None = None) -> None:
    """Record an explicit ``op`` for a raw-SQL writer (instrument merge)."""
    if not enabled():
        _guard(session)
        return
    if table_name not in SPECS or op not in EXPLICIT_OPS:
        raise ValueError(f"unknown explicit emit {table_name}.{op}")
    conn = session.connection()
    if not _tables_ready(conn):
        return
    st = _state(session)
    conn.execute(
        insert(OUTBOX),
        [
            _outbox_row(
                st,
                profile_id=profile_id,
                table_name=table_name,
                op=op,
                local_id=local_id,
                gid=_row_gid(conn, st, table_name, profile_id, local_id),
                fields=_plain(fields or {}),
                key=_plain(key) if key else None,
            )
        ],
    )


def emit_instrument_merge(session, source_id: int, target_id: int) -> None:
    """``instrument.merged``: one row for the whole raw-SQL merge (the fold remaps the references,
    events.md 6.4); the source instrument's gid mappings go with it."""
    if not enabled():
        _guard(session)
        return
    emit(
        session,
        "inv_instruments",
        "merge",
        str(source_id),
        fields={"source_id": source_id, "target_id": target_id},
        key={"source": str(source_id), "target": str(target_id)},
    )
    conn = session.connection()
    if _tables_ready(conn):
        _drop_gid(conn, _state(session), None, "inv_instruments", str(source_id))


# --------------------------------------------------------------------------- #
# Shipper side: status, ack, prune, link
# --------------------------------------------------------------------------- #

_VAULT_ID = re.compile(r"^[0-9a-f]{32}$")
_GID = re.compile(
    r"^([0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
)


def status(session) -> dict:
    """Counts for ``cashu sync status``: per profile id (and shared) pending / acked rows, rows without
    a gid, by op; vault and salt presence. No values."""
    conn = session.connection()
    ready = _tables_ready(conn)
    out: dict = {"enabled": enabled(), "tables": ready, "profiles": {}}
    if not ready:
        return out
    rows = conn.execute(
        select(
            OUTBOX.c.profile_id,
            OUTBOX.c.acked_at.is_(None).label("pending"),
            OUTBOX.c.gid.is_(None).label("no_gid"),
            func.count(),
        ).group_by(OUTBOX.c.profile_id, "pending", "no_gid")
    ).all()
    for pid, pending, no_gid, n in rows:
        entry = out["profiles"].setdefault(pid, {"pending": 0, "acked": 0, "without_gid": 0})
        entry["pending" if pending else "acked"] += n
        if no_gid and pending:
            entry["without_gid"] += n
    for pid, vault in conn.execute(select(VAULTS.c.profile_id, VAULTS.c.vault_id)).all():
        entry = out["profiles"].setdefault(pid, {"pending": 0, "acked": 0, "without_gid": 0})
        entry["vault"] = True
        entry["salt"] = sync_keys.gid_salt(vault) is not None
    out["oldest_pending_id"] = conn.execute(
        select(func.min(OUTBOX.c.id)).where(OUTBOX.c.acked_at.is_(None))
    ).scalar()
    out["ids"] = conn.execute(select(func.count()).select_from(IDS)).scalar()
    return out


def pending(session, after: int = 0, limit: int = 1000) -> list[dict]:
    """Unacked rows after id ``after``, oldest first (the shipper's read)."""
    conn = session.connection()
    q = (
        select(OUTBOX)
        .where(OUTBOX.c.id > after, OUTBOX.c.acked_at.is_(None))
        .order_by(OUTBOX.c.id)
        .limit(limit)
    )
    return [dict(r._mapping) for r in conn.execute(q)]


HLC_RE = re.compile(r"^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-f]{32}$")
"""An HLC (events.md 3.1): wall ms base36 (9), counter base36 (4), device (32 hex)."""
ULID_RE = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")


@dataclass(frozen=True)
class _AckEntry:
    profile_id: int
    table: str
    local_id: str
    gid: str | None
    clocks: dict[str, tuple[str, str]]


def _ack_entry(e: Any) -> _AckEntry:
    """One validated ack entry (``ValueError`` otherwise; nothing is written for a bad call)."""
    e = e if isinstance(e, dict) else {}
    pid, name, local_id = e.get("profile_id"), e.get("table"), e.get("local_id")
    if (
        not isinstance(pid, int)
        or isinstance(pid, bool)
        or not isinstance(name, str)
        or name not in SPECS
        or isinstance(local_id, bool)
        or not isinstance(local_id, str | int)
    ):
        raise ValueError("bad ack entry")
    gid = e.get("gid")
    if gid is not None and not (isinstance(gid, str) and _GID.match(gid)):
        raise ValueError("bad gid mapping in an ack")
    raw = e.get("clocks")
    clocks: dict[str, tuple[str, str]] = {}
    if raw is not None:
        if not isinstance(raw, dict):
            raise ValueError("bad field clocks in an ack")
        columns = {c.name for c in _synced_columns(name, IDS.metadata.tables[name])}
        for col, stamp in raw.items():
            if (
                col not in columns
                or not isinstance(stamp, list | tuple)
                or len(stamp) != 2
                or not isinstance(stamp[0], str)
                or not isinstance(stamp[1], str)
                or not HLC_RE.match(stamp[0])
                or not ULID_RE.match(stamp[1])
            ):
                raise ValueError("bad field clock in an ack")
            clocks[col] = (stamp[0], stamp[1])
    return _AckEntry(pid, name, str(local_id), gid, clocks)


def ack(session, through: int, entries: Iterable[dict] = (), *, now: dt.datetime | None = None) -> int:
    """Mark every row with id <= ``through`` shipped and store what the shipper returns per row
    (S31a P-A): ``{"profile_id", "table", "local_id", "gid"?, "clocks"?: {column: [hlc, eid]}}``.

    - ``gid``: the gid the shipper computed (upserted into ``sync_ids``, source ``shipper``).
    - ``clocks``: the ``(hlc, eid)`` each synced column was stamped with in the log; ``sync_clock``
      moves to the max of the stored and the given stamp (events.md 3.2 order, plain string compare),
      so the inbound compare (``sync_apply``) sees the local write's real stamp even after a prune.

    Every entry is validated first (table in ``SPECS``, int profile, gid shape, column synced, HLC of
    events.md 3.1, ULID eid): on any bad entry ``ValueError`` and nothing is written. Idempotent: the
    same call again changes nothing. Returns the number of rows acked."""
    parsed = [_ack_entry(e) for e in entries]
    conn = session.connection()
    stamps: dict[tuple[int, str, str, str], tuple[str, str]] = {}
    for e in parsed:
        if e.gid is not None:
            mine = and_(IDS.c.profile_id == e.profile_id, IDS.c.table_name == e.table)
            conn.execute(delete(IDS).where(mine, or_(IDS.c.local_id == e.local_id, IDS.c.gid == e.gid)))
            conn.execute(
                insert(IDS).values(
                    profile_id=e.profile_id, table_name=e.table, local_id=e.local_id, gid=e.gid, source="shipper"
                )
            )
        for col, stamp in e.clocks.items():
            k = (e.profile_id, e.table, e.local_id, col)
            stamps[k] = max(stamps.get(k, stamp), stamp)
    for (pid, name, local_id, col), stamp in stamps.items():
        where = and_(
            CLOCKS.c.profile_id == pid,
            CLOCKS.c.table_name == name,
            CLOCKS.c.local_id == local_id,
            CLOCKS.c.field == col,
        )
        held = conn.execute(select(CLOCKS.c.hlc, CLOCKS.c.eid).where(where)).first()
        if held is None:
            conn.execute(
                insert(CLOCKS).values(
                    profile_id=pid, table_name=name, local_id=local_id, field=col, hlc=stamp[0], eid=stamp[1]
                )
            )
        elif (held.hlc, held.eid) < stamp:  # clocks only move forward
            conn.execute(update(CLOCKS).where(where).values(hlc=stamp[0], eid=stamp[1]))
    result = conn.execute(
        update(OUTBOX)
        .where(OUTBOX.c.id <= through, OUTBOX.c.acked_at.is_(None))
        .values(acked_at=now or utcnow())
    )
    return result.rowcount or 0


GENESIS_SOURCE = "genesis"


def _seed_row(conn, name: str, local_id: str) -> dict | None:
    """The local row a seed entry names (``local_id`` in :func:`_local_id` form), None when absent."""
    table = IDS.metadata.tables.get(name)
    if table is None:
        return None
    cols = list(table.primary_key.columns)
    values = local_id.split("|")
    if len(values) != len(cols):
        return None
    where = []
    for col, raw in zip(cols, values, strict=True):
        if isinstance(col.type, Integer):
            if not raw.isdigit():
                return None
            where.append(col == int(raw))
        else:
            where.append(col == raw)
    row = conn.execute(select(table).where(*where)).mappings().first()
    return dict(row) if row is not None else None


def _verify_seed_salt(conn, profile_id: int, vault: str, entries: list[dict]) -> None:
    """F4: the export's DET gids must be the ones Python computes with the vault's keychain salt.
    Recomputes the first verifiable DET entry (a ``profile_modules`` one first; refs resolve through
    the file itself) and raises ``ValueError`` when the salt is missing, the gid differs or no entry
    can be recomputed from local data."""
    salt = sync_keys.gid_salt(vault)
    if salt is None:
        raise ValueError("the keychain holds no gid salt for this vault; store it before seeding")
    st = _State()
    st.salts[profile_id] = salt
    for e in entries:
        if e.get("table") != "profiles":
            st.gids[(profile_id, e["table"], e["localId"])] = e["gid"]
    det = [e for e in entries if e.get("table") != "profiles" and SPECS[e["table"]].gid == "det"]
    det.sort(key=lambda e: e["table"] != "profile_modules")
    for e in det:
        row = _seed_row(conn, e["table"], e["localId"])
        if row is None or _profile_of(conn, st, e["table"], row, IDS.metadata) != profile_id:
            continue
        computed = _det_gid(conn, st, e["table"], row, profile_id)
        if computed is None:
            continue
        if computed != e["gid"]:
            raise ValueError("the export's gids do not match this vault's keychain salt; nothing was seeded")
        return
    raise ValueError("no entry of the ids file can be recomputed to verify the gid salt; nothing was seeded")


def seed_ids(session, profile_id: int, rows: Iterable[dict]) -> dict:
    """Seed ``sync_ids`` (and the vault link) of one profile from the genesis exporter's ``ids.jsonl``
    (S26): ``{"table", "localId", "gid"}`` per exported row, ``localId`` in :func:`_local_id` form;
    the ``profiles`` entry carries the vault id and must name ``profile_id``. All or nothing: every
    entry is classified first (held = kept; a row or gid mapped to something else, in the map or twice
    in the file, = conflict) and on any conflict nothing is written. Idempotent for the same vault.
    Returns counts (never values). Raises ``ValueError`` on a malformed file, another profile's file,
    a profile already linked to another vault (never relinked silently) or a gid salt that is missing
    from the keychain or does not reproduce the export's DET gids (:func:`_verify_seed_salt`)."""
    conn = session.connection()
    entries = list(rows)
    vaults = [e for e in entries if e.get("table") == "profiles"]
    if len(vaults) != 1 or str(vaults[0].get("localId")) != str(profile_id):
        raise ValueError("the ids file has no entry for this profile (another profile's file?)")
    vault = vaults[0].get("gid")
    if not isinstance(vault, str) or not _VAULT_ID.match(vault):
        raise ValueError("a vault id is 32 lower-case hex characters")
    linked = _vault_of(conn, profile_id)
    if linked is not None and linked != vault:
        raise ValueError("this profile is linked to another vault; unlink it first (never relinked silently)")
    clash = conn.execute(
        select(VAULTS.c.profile_id).where(VAULTS.c.vault_id == vault, VAULTS.c.profile_id != profile_id)
    ).first()
    if clash is not None:
        raise ValueError("that vault is linked to another profile")
    out = {"inserted": 0, "kept": 0, "conflicts": 0}
    fresh: list[tuple[str, str, str]] = []
    seen_ids: set[tuple[str, str]] = set()
    seen_gids: set[tuple[str, str]] = set()
    for e in entries:
        name, local_id, gid = e.get("table"), e.get("localId"), e.get("gid")
        if name == "profiles":
            continue
        spec = SPECS.get(name) if isinstance(name, str) else None
        if (
            spec is None
            or spec.gid == "none"
            or not isinstance(local_id, str)
            or not isinstance(gid, str)
            or not _GID.match(gid)
        ):
            raise ValueError("bad entry in the ids file")
        if (name, local_id) in seen_ids or (name, gid) in seen_gids:
            out["conflicts"] += 1
            continue
        seen_ids.add((name, local_id))
        seen_gids.add((name, gid))
        held = conn.execute(
            select(IDS.c.local_id, IDS.c.gid).where(
                IDS.c.profile_id == profile_id,
                IDS.c.table_name == name,
                or_(IDS.c.local_id == local_id, IDS.c.gid == gid),
            )
        ).all()
        if any(h.local_id == local_id and h.gid == gid for h in held):
            out["kept"] += 1
        elif held:
            out["conflicts"] += 1
        else:
            fresh.append((name, local_id, gid))
    _verify_seed_salt(conn, profile_id, vault, [e for e in entries if e.get("table") != "profiles"])
    if out["conflicts"]:
        return out
    for name, local_id, gid in fresh:
        conn.execute(
            insert(IDS).values(
                profile_id=profile_id, table_name=name, local_id=local_id, gid=gid, source=GENESIS_SOURCE
            )
        )
    out["inserted"] = len(fresh)
    if linked is None:
        link_vault(session, profile_id, vault)
    return out


def prune(session) -> int:
    """Delete acked rows only: an unacked row is never pruned."""
    conn = session.connection()
    if not _tables_ready(conn):
        return 0
    return conn.execute(delete(OUTBOX).where(OUTBOX.c.acked_at.is_not(None))).rowcount or 0


def link_vault(session, profile_id: int, vault_id: str) -> None:
    """Record which vault a profile is (32 lower-case hex, the S27 vault id)."""
    if not _VAULT_ID.match(vault_id or ""):
        raise ValueError("a vault id is 32 lower-case hex characters")
    conn = session.connection()
    clash = conn.execute(
        select(VAULTS.c.profile_id).where(VAULTS.c.vault_id == vault_id, VAULTS.c.profile_id != profile_id)
    ).first()
    if clash is not None:
        raise ValueError("that vault is linked to another profile")
    conn.execute(delete(VAULTS).where(VAULTS.c.profile_id == profile_id))
    conn.execute(insert(VAULTS).values(profile_id=profile_id, vault_id=vault_id, linked_at=utcnow()))
    session.info.pop(GUARD_KEY, None)
    sync_keys.forget_cached_salts()


def rows_of(session, *, profile_id: int | None = None, table_name: str | None = None) -> list[dict]:
    """Outbox rows (tests and diagnostics), oldest first."""
    conn = session.connection()
    q = select(OUTBOX).order_by(OUTBOX.c.id)
    if profile_id is not None:
        q = q.where(OUTBOX.c.profile_id == profile_id)
    if table_name is not None:
        q = q.where(OUTBOX.c.table_name == table_name)
    return [dict(r._mapping) for r in conn.execute(q)]

