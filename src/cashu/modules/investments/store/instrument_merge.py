"""Merge two instruments that are the same security (a duplicate made by watching it once by ISIN and
once by ticker, or by two imports that resolved differently) into one.

Every row that points at the source instrument is moved to the target, then the source row is
deleted. Which tables point at an instrument is read from the live database (``PRAGMA
foreign_key_list``), not from the models, so a table added by a later migration is never left behind:
a table without a known policy and without a unique key on the reference is simply re-pointed; one
with a unique key and no policy stops the merge.

Rows that would collide on a unique key are resolved per table (the target's row always wins):

- ``watchlist_items`` (one per profile): the target's entry stays; an empty note takes the source's,
  tags are joined, and the entry is watched again when only the source's was active.
- ``inv_profile_instruments`` (one per profile): the target's identity and classification stay; the
  owner's annotations move when the target has none (the plan with its date and reason as one group,
  tags, region, sector), and a segment the owner chose beats one the research agent set. Source values
  that were not taken are listed in the report.
- market data (``inv_price_bars``, ``inv_position_snapshots``, ``inv_manual_valuations``): the
  target's row for the same key stays, the source's duplicate is dropped.
- ``inv_instrument_renames``: a rename between the two instruments (it would become "X to X") is
  dropped first; a source rename that duplicates a target one is dropped; the rest is re-pointed.
- ``inv_signals``: re-pointed with their dedup keys (``...|i:<id>``), so the daily check keeps
  matching them; an open source signal whose new key is already open for the target is resolved.

Theses, research notes, alerts, signals, decisions, transactions and aliases have no such key and are
moved as they are (a profile may have several theses of one instrument: the newest is current). Market
identity: the target keeps its symbol and ISIN and takes the source's when it has none. Two different
ISINs, or two currencies, stop the merge (those are different securities).

Runs in the caller's transaction; ``dry_run`` rolls it back after building the report. A database
constraint that still fails is raised as :class:`MergeError` (the transaction is rolled back)."""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

INSTRUMENTS = "inv_instruments"

# Tables with a unique key on the instrument reference whose collisions are dropped on the source side
# (market data, refetchable or recomputed): table -> key columns besides the instrument column.
_KEEP_TARGET = {
    "inv_price_bars": ("date",),
    "inv_position_snapshots": ("account_id", "as_of"),
    "inv_manual_valuations": ("profile_id", "as_of"),
}
_PER_PROFILE = {"watchlist_items", "inv_profile_instruments"}
_RENAMES = "inv_instrument_renames"
_SIGNALS = "inv_signals"
_OPEN_SIGNAL = ("active", "acknowledged")
# Override fields that travel together (the owner's plan: value, when, the model's reason).
_PLAN_GROUP = ("plan", "plan_at", "plan_reason")
_SEGMENT_GROUP = ("segment", "segment_by")
# Owner annotations an empty target field takes from the source. Identity and classification (name,
# asset class, valuation mode, status, reviewed flag) always stay the target's: a duplicate is
# usually a badly classified stub, and taking its class could make the target private again.
_FILLABLE = ("tags", "region", "sector")


class MergeError(ValueError):
    """The two instruments cannot be merged (not found, the same row, different ISIN or currency, or
    a table with a unique key on the instrument that this module does not know how to resolve)."""


@dataclass
class MergeReport:
    source_id: int
    target_id: int
    source_name: str
    target_name: str
    moved: dict[str, int] = field(default_factory=dict)
    """Rows re-pointed from the source to the target, per ``table.column``."""
    dropped: dict[str, int] = field(default_factory=dict)
    """Source rows dropped because the target already had the same key, per table."""
    notes: list[str] = field(default_factory=list)
    """What was kept, joined or taken over, in words (for the CLI)."""
    dry_run: bool = False


def _references(session: Session) -> list[tuple[str, str]]:
    """Every (table, column) with a foreign key to ``inv_instruments``, from the live schema."""
    conn = session.connection()
    tables = [
        r[0]
        for r in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    refs: list[tuple[str, str]] = []
    for table in tables:
        for fk in conn.exec_driver_sql(f'PRAGMA foreign_key_list("{table}")'):
            if fk[2] == INSTRUMENTS:
                refs.append((table, fk[3]))
    return refs


def _unique_keys(session: Session, table: str, column: str) -> list[list[str]]:
    """The unique indexes of ``table`` that include ``column`` (their column lists)."""
    conn = session.connection()
    keys: list[list[str]] = []
    for idx in conn.exec_driver_sql(f'PRAGMA index_list("{table}")'):
        if not idx[2]:  # not unique
            continue
        cols = [c[2] for c in conn.exec_driver_sql(f'PRAGMA index_info("{idx[1]}")')]
        if column in cols:
            keys.append(cols)
    return keys


def _instrument(session: Session, instrument_id: int) -> dict:
    row = (
        session.connection()
        .execute(
            text("SELECT id, name, currency, symbol, isin FROM inv_instruments WHERE id = :id"),
            {"id": instrument_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise MergeError(f"No instrument {instrument_id}")
    return dict(row)


def _count(session: Session, table: str, column: str, instrument_id: int) -> int:
    return (
        session.connection()
        .execute(
            text(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = :id'), {"id": instrument_id}
        )
        .scalar_one()
    )


def _repoint(session: Session, table: str, column: str, source: int, target: int) -> int:
    result = session.connection().execute(
        text(f'UPDATE "{table}" SET "{column}" = :target WHERE "{column}" = :source'),
        {"source": source, "target": target},
    )
    return result.rowcount or 0


def _drop_colliding(
    session: Session, table: str, column: str, key: tuple[str, ...], source: int, target: int
) -> int:
    """Delete the source rows whose key already exists for the target."""
    same = " AND ".join(f't."{k}" IS "{table}"."{k}"' for k in key)
    result = session.connection().execute(
        text(
            f'DELETE FROM "{table}" WHERE "{column}" = :source AND EXISTS ('
            f'SELECT 1 FROM "{table}" t WHERE t."{column}" = :target AND {same})'
        ),
        {"source": source, "target": target},
    )
    return result.rowcount or 0


def _merge_watchlist(session: Session, report: MergeReport, source: int, target: int) -> int:
    conn = session.connection()
    rows = conn.execute(
        text(
            "SELECT s.id AS sid, t.id AS tid, s.profile_id AS profile_id, s.note AS snote, "
            "t.note AS tnote, s.tags AS stags, t.tags AS ttags, s.removed_at AS sremoved, "
            "t.removed_at AS tremoved FROM watchlist_items s JOIN watchlist_items t "
            "ON t.profile_id = s.profile_id AND t.instrument_id = :target "
            "WHERE s.instrument_id = :source"
        ),
        {"source": source, "target": target},
    ).mappings()
    dropped = 0
    for r in list(rows):
        updates: dict[str, object] = {}
        if not (r["tnote"] or "").strip() and (r["snote"] or "").strip():
            updates["note"] = r["snote"]
        stags = json.loads(r["stags"] or "[]") or []
        ttags = json.loads(r["ttags"] or "[]") or []
        joined = list(dict.fromkeys([*ttags, *stags]))
        if joined != ttags:
            updates["tags"] = json.dumps(joined)
        if r["tremoved"] is not None and r["sremoved"] is None:
            updates["removed_at"] = None
        if updates:
            sets = ", ".join(f"{k} = :{k}" for k in updates)
            conn.execute(
                text(f"UPDATE watchlist_items SET {sets} WHERE id = :id"),
                {**updates, "id": r["tid"]},
            )
            report.notes.append(
                f"watchlist entry {r['tid']} (profile {r['profile_id']}) took over from entry "
                f"{r['sid']}: {', '.join(sorted(updates))}"
            )
        conn.execute(text("DELETE FROM watchlist_items WHERE id = :id"), {"id": r["sid"]})
        report.notes.append(
            f"watchlist entry {r['sid']} (profile {r['profile_id']}) merged into entry {r['tid']}"
        )
        dropped += 1
    return dropped


def _merge_overrides(session: Session, report: MergeReport, source: int, target: int) -> int:
    conn = session.connection()
    pairs = conn.execute(
        text(
            "SELECT s.id AS sid, t.id AS tid FROM inv_profile_instruments s "
            "JOIN inv_profile_instruments t "
            "ON t.profile_id = s.profile_id AND t.instrument_id = :target "
            "WHERE s.instrument_id = :source"
        ),
        {"source": source, "target": target},
    ).all()
    dropped = 0
    for sid, tid in pairs:
        src = dict(
            conn.execute(text("SELECT * FROM inv_profile_instruments WHERE id = :id"), {"id": sid})
            .mappings()
            .one()
        )
        tgt = dict(
            conn.execute(text("SELECT * FROM inv_profile_instruments WHERE id = :id"), {"id": tid})
            .mappings()
            .one()
        )
        updates: dict[str, object] = {}
        lost = {
            k: src[k]
            for k in ("name", "asset_class", "valuation_mode", "status")
            if k in src and src[k] is not None and src[k] != tgt[k]
        }
        groups = [_PLAN_GROUP, _SEGMENT_GROUP, *((k,) for k in _FILLABLE)]
        for group in groups:
            group = tuple(k for k in group if k in src)
            if not group or all(_empty(src[k]) for k in group):
                continue
            head = group[0]
            take = _empty(tgt[head])
            if group == _SEGMENT_GROUP and tgt["segment_by"] != "owner":
                take = take or src["segment_by"] == "owner"
            if take:
                updates.update({k: src[k] for k in group})
            elif any(src[k] != tgt[k] for k in group):
                lost.update({k: src[k] for k in group})
        conn.execute(text("DELETE FROM inv_profile_instruments WHERE id = :id"), {"id": sid})
        if updates:
            sets = ", ".join(f'"{k}" = :{k}' for k in updates)
            conn.execute(
                text(f"UPDATE inv_profile_instruments SET {sets} WHERE id = :id"),
                {**updates, "id": tid},
            )
        report.notes.append(
            f"profile {src['profile_id']}: classification merged; took {sorted(updates) or 'nothing'}"
            + (f", the target's values replaced the source's {lost}" if lost else "")
        )
        dropped += 1
    return dropped


def _empty(value: object) -> bool:
    """NULL, or a JSON column's stored ``null``."""
    return value is None or value == "null"


def _merge_renames(session: Session, report: MergeReport, source: int, target: int) -> None:
    """Drop the renames that the merge makes meaningless or duplicate, then re-point the rest."""
    conn = session.connection()
    selfs = (
        conn.execute(
            text(
                f"DELETE FROM {_RENAMES} WHERE old_instrument_id IN (:s, :t) "
                "AND new_instrument_id IN (:s, :t)"
            ),
            {"s": source, "t": target},
        ).rowcount
        or 0
    )
    dupes = 0
    for column, other in (
        ("old_instrument_id", "new_instrument_id"),
        ("new_instrument_id", "old_instrument_id"),
    ):
        dupes += _drop_colliding(
            session, _RENAMES, column, ("profile_id", "date", other), source, target
        )
        moved = _repoint(session, _RENAMES, column, source, target)
        if moved:
            report.moved[f"{_RENAMES}.{column}"] = moved
    if selfs + dupes:
        report.dropped[_RENAMES] = selfs + dupes


def _merge_signals(session: Session, report: MergeReport, source: int, target: int) -> None:
    """Re-point signals and rewrite the ``|i:<source>`` part of their dedup keys."""
    conn = session.connection()
    pattern = re.compile(rf"\|i:{source}(?=$|\|)")
    rows = (
        conn.execute(
            text(
                f"SELECT id, profile_id, dedup_key, status FROM {_SIGNALS} WHERE instrument_id = :s"
            ),
            {"s": source},
        )
        .mappings()
        .all()
    )
    closed = 0
    now = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M:%S.%f")  # as SQLModel stores it
    for r in rows:
        key = pattern.sub(f"|i:{target}", r["dedup_key"])
        status = r["status"]
        if key != r["dedup_key"] and status in _OPEN_SIGNAL:
            clash = conn.execute(
                text(
                    f"SELECT 1 FROM {_SIGNALS} WHERE profile_id = :p AND dedup_key = :k "
                    "AND status IN ('active', 'acknowledged') AND id != :id"
                ),
                {"p": r["profile_id"], "k": key, "id": r["id"]},
            ).first()
            if clash is not None:
                conn.execute(
                    text(
                        f"UPDATE {_SIGNALS} SET status = 'resolved', closed_at = :now WHERE id = :id"
                    ),
                    {"now": now, "id": r["id"]},
                )
                closed += 1
        conn.execute(
            text(f"UPDATE {_SIGNALS} SET dedup_key = :k, instrument_id = :t WHERE id = :id"),
            {"k": key, "t": target, "id": r["id"]},
        )
    if rows:
        report.moved[f"{_SIGNALS}.instrument_id"] = len(rows)
    if closed:
        report.notes.append(
            f"{closed} open signal(s) of the source resolved: the target already had the same one"
        )


def merge_instruments(
    session: Session, source_id: int, target_id: int, *, dry_run: bool = False
) -> MergeReport:
    """Move everything of ``source_id`` to ``target_id`` and delete ``source_id`` (see the module
    docstring). Raises :class:`MergeError` before any write when the merge is not safe."""
    if source_id == target_id:
        raise MergeError("Source and target are the same instrument")
    source = _instrument(session, source_id)
    target = _instrument(session, target_id)
    if (source["currency"] or "").upper() != (target["currency"] or "").upper():
        raise MergeError(
            f"Different currencies ({source['currency']} vs {target['currency']}): "
            "not the same security"
        )
    if source["isin"] and target["isin"] and source["isin"].upper() != target["isin"].upper():
        raise MergeError(
            f"Different ISINs ({source['isin']} vs {target['isin']}): not the same security"
        )
    refs = _references(session)
    for table, column in refs:
        known = table in _KEEP_TARGET or table in _PER_PROFILE or table in (_RENAMES, _SIGNALS)
        if (
            not known
            and _unique_keys(session, table, column)
            and _count(session, table, column, source_id)
        ):
            raise MergeError(
                f"{table}.{column} has a unique key on the instrument and no merge rule; "
                "extend instrument_merge before merging"
            )

    report = MergeReport(
        source_id=source_id,
        target_id=target_id,
        source_name=source["name"],
        target_name=target["name"],
        dry_run=dry_run,
    )
    try:
        _apply(session, report, refs, source, target)
    except IntegrityError as e:
        session.rollback()
        raise MergeError(
            f"A database constraint stopped the merge, nothing was written: {e.orig}"
        ) from None
    session.flush()
    if dry_run:
        session.rollback()
    return report


def _apply(
    session: Session, report: MergeReport, refs: list[tuple[str, str]], source: dict, target: dict
) -> None:
    source_id, target_id = source["id"], target["id"]
    for table, column in refs:
        if table == _RENAMES:
            continue  # both columns at once, below
        if table == _SIGNALS:
            _merge_signals(session, report, source_id, target_id)
            continue
        dropped = 0
        if table == "watchlist_items":
            dropped = _merge_watchlist(session, report, source_id, target_id)
        elif table == "inv_profile_instruments":
            dropped = _merge_overrides(session, report, source_id, target_id)
        elif table in _KEEP_TARGET:
            dropped = _drop_colliding(
                session, table, column, _KEEP_TARGET[table], source_id, target_id
            )
        if dropped:
            report.dropped[table] = report.dropped.get(table, 0) + dropped
        moved = _repoint(session, table, column, source_id, target_id)
        if moved:
            report.moved[f"{table}.{column}"] = moved
    if any(t == _RENAMES for t, _ in refs):
        _merge_renames(session, report, source_id, target_id)

    for col in ("isin", "symbol"):
        if not target[col] and source[col]:
            session.connection().execute(
                text(f"UPDATE inv_instruments SET {col} = :v WHERE id = :id"),
                {"v": source[col], "id": target_id},
            )
            report.notes.append(f"target took the source's {col} {source[col]}")
    session.connection().execute(
        text("DELETE FROM inv_instruments WHERE id = :id"), {"id": source_id}
    )
