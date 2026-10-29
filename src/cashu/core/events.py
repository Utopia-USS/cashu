"""Typed change events for the open app (P10 live data).

Every process that writes through the ORM session layer (the app, the worker, an agent's ``cashu mcp``)
records ``change_events`` rows in the same transaction as the change: a session hook (``after_flush``)
turns inserted / updated / deleted rows of the watched tables into ``add`` / ``update`` / ``remove``
events, a bulk ``update(...)`` / ``delete(...)`` of a watched table becomes one ``update`` event without
a row id, and code that writes with plain SQL (prices) calls :func:`emit`. The app server tails the
table by id (:func:`tail`, only after ``PRAGMA data_version`` moved, ``core/changes.py``) and pushes the
events to the window; :func:`prune` drops rows older than a day.

Watched tables and the payload builders come from the modules: core imports
``cashu.modules.<id>.live`` when it exists (``register(watch, register_payload)``), on first use, so a
module never needs core to know its tables. Payloads (the full wire dict of a list row, built by the
server's own view functions at push time) are only built by the app server for the window, never stored.
"""

from __future__ import annotations

import datetime as dt
import importlib
import importlib.util
import logging
import threading
import weakref
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, event, func, insert, inspect
from sqlalchemy.orm import Session as OrmSession
from sqlmodel import select

from .models import ChangeEvent, utcnow

ENTITIES = (
    "note",
    "thesis",
    "topic_thesis",
    "segment_assignment",
    "alert",
    "watchlist",
    "proposal",
    "signal",
    "prices",
    "run",
)
OPS = ("add", "update", "remove")
RETENTION = dt.timedelta(days=1)
TABLE = ChangeEvent.__table__

PayloadBuilder = Callable[[Any, Any, str], dict | None]
"""``(session, profile, ref) -> wire dict`` of one row, None when it is gone or not the profile's."""

_log = logging.getLogger("cashu.events")
_tables: dict[str, str] = {"proposals": "proposal"}
_payloads: dict[str, PayloadBuilder] = {}
_loaded = False
_load_lock = threading.Lock()
_has_table: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def watch(table: str, entity: str) -> None:
    """Rows of ``table`` become events of ``entity``."""
    if entity not in ENTITIES:
        raise ValueError(f"unknown entity {entity!r}")
    _tables[table] = entity


def register_payload(entity: str, builder: PayloadBuilder) -> None:
    _payloads[entity] = builder


def _proposal_payload(session, profile, ref: str) -> dict | None:
    from . import proposals
    from .agent_models import Proposal

    row = session.get(Proposal, int(ref))
    if row is None or row.profile_id != profile.id:
        return None
    return proposals.proposal_dict(row)


def load() -> None:
    """Import every module's ``live`` registrations once (cheap; lazy imports inside them)."""
    global _loaded
    if _loaded:
        return
    with _load_lock:
        if _loaded:
            return
        from .modules import MODULE_IDS

        register_payload("proposal", _proposal_payload)
        for module_id in MODULE_IDS:
            name = f"cashu.modules.{module_id}.live"
            try:
                if importlib.util.find_spec(name) is None:
                    continue
                importlib.import_module(name).register(watch, register_payload)
            except Exception:  # noqa: BLE001 - live data is a convenience, never a write failure
                _log.warning("change events of %s not registered", module_id, exc_info=True)
        _loaded = True


def watched_tables() -> dict[str, str]:
    load()
    return dict(_tables)


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #


def _row(entity: str, op: str, profile_id: int | None, ref, payload: dict | None) -> dict:
    return {
        "ts": utcnow(),
        "profile_id": profile_id,
        "entity": entity,
        "op": op,
        "ref": None if ref is None else str(ref),
        "payload": payload,
    }


def _table_ready(connection) -> bool:
    """The DB has ``change_events`` (an older schema in a migration test does not): checked once
    per engine while it has it."""
    engine = connection.engine
    if _has_table.get(engine):
        return True
    ok = inspect(connection).has_table(TABLE.name)
    if ok:
        _has_table[engine] = True
    return ok


def _insert(connection, rows: list[dict]) -> None:
    if rows and _table_ready(connection):
        connection.execute(insert(TABLE), rows)


def emit(
    session,
    entity: str,
    op: str,
    *,
    profile_id: int | None = None,
    ref=None,
    payload: dict | None = None,
) -> None:
    """Record one event in the session's transaction (writes done with plain SQL, runs)."""
    try:
        _insert(session.connection(), [_row(entity, op, profile_id, ref, payload)])
    except Exception:  # noqa: BLE001 - never fail the caller's write
        _log.warning("change event %s/%s not recorded", entity, op, exc_info=True)


def _entity_of(obj) -> str | None:
    return _tables.get(getattr(obj, "__tablename__", None) or "")


@event.listens_for(OrmSession, "after_flush")
def _after_flush(session, _context) -> None:
    load()
    rows: list[dict] = []
    for objs, op in ((session.new, "add"), (session.dirty, "update"), (session.deleted, "remove")):
        for obj in objs:
            entity = _entity_of(obj)
            if entity is None:
                continue
            if op == "update" and not session.is_modified(obj, include_collections=False):
                continue
            rows.append(
                _row(entity, op, getattr(obj, "profile_id", None), getattr(obj, "id", None), None)
            )
    if not rows:
        return
    try:
        _insert(session.connection(), rows)
    except Exception:  # noqa: BLE001 - never fail the caller's write
        _log.warning("change events not recorded", exc_info=True)


@event.listens_for(OrmSession, "do_orm_execute")
def _bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    table = getattr(getattr(mapper, "local_table", None), "name", None)
    load()
    entity = _tables.get(table or "")
    if entity is None:
        return
    try:
        _insert(state.session.connection(), [_row(entity, "update", None, None, None)])
    except Exception:  # noqa: BLE001
        _log.warning("bulk change event not recorded", exc_info=True)


# --------------------------------------------------------------------------- #
# Reading (the app server)
# --------------------------------------------------------------------------- #


def last_id(session) -> int:
    return session.exec(select(func.max(ChangeEvent.id))).one() or 0


def first_id(session) -> int | None:
    return session.exec(select(func.min(ChangeEvent.id))).one()


def tail(session, profile_id: int, after: int, limit: int = 500) -> list[ChangeEvent]:
    """Events after id ``after`` of the profile or shared (``profile_id`` NULL), oldest first."""
    return list(
        session.exec(
            select(ChangeEvent)
            .where(ChangeEvent.id > after)
            .where((ChangeEvent.profile_id == profile_id) | (ChangeEvent.profile_id.is_(None)))
            .order_by(ChangeEvent.id)
            .limit(limit)
        ).all()
    )


def wire(session, profile, row: ChangeEvent) -> dict:
    """One event for the window, with the row's wire dict for list entities (add / update)."""
    out = {
        "id": row.id,
        "entity": row.entity,
        "op": row.op,
        "ref": row.ref,
        "profile": profile.slug if row.profile_id is not None else None,
        "payload": row.payload,
    }
    builder = _payloads.get(row.entity)
    if builder is not None and row.op != "remove" and row.ref is not None:
        try:
            item = builder(session, profile, row.ref)
        except Exception:  # noqa: BLE001 - the window re-reads instead
            _log.warning("payload of %s %s failed", row.entity, row.ref, exc_info=True)
            item = None
        if item is None:
            out["op"] = "remove" if row.op == "update" else row.op
        out["payload"] = {"item": item, **(row.payload or {})} if item is not None else row.payload
    return out


def since(session, profile, after: int | None, limit: int = 500) -> dict:
    """``{last_id, events, reset}`` for the window: ``after`` None = only the baseline id; ``reset``
    when events after ``after`` may have been pruned (the window re-reads everything)."""
    load()
    newest = last_id(session)
    if after is None or after > newest:
        return {"last_id": newest, "events": [], "reset": after is not None and after > newest}
    oldest = first_id(session)
    reset = after > 0 and oldest is not None and oldest > after + 1 and newest > after
    rows = tail(session, profile.id, after, limit)
    events = [wire(session, profile, r) for r in rows]
    scanned = rows[-1].id if len(rows) == limit else newest
    return {"last_id": scanned, "events": events, "reset": bool(reset)}


def prune(session, now: dt.datetime | None = None) -> int:
    now = now or utcnow()
    if not _table_ready(session.connection()):
        return 0
    result = session.exec(delete(ChangeEvent).where(ChangeEvent.ts < now - RETENTION))
    return result.rowcount or 0
