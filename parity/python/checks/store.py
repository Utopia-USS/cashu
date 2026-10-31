"""Roundtrip goldens of the synced tables (S26 genesis, spec 8.1 / 8.2): ``store.table.<table>``.

One check per table of ``sync_outbox.SPECS``; ``inv_decision_signals`` has none of its own, its links
ride in the ``inv_decisions`` rows (pseudo-column ``signals``). The TS side (``packages/parity/src/
producers/store``) rebuilds the same tree from the genesis log, so this file fixes the contract:

- Tree ``{"profiles": {<profile natural key>: [rows]}}``, every profile present (``[]`` when it has
  no rows). A row is an object of the table's ``ROUNDTRIP_COLUMNS`` (mirrored verbatim by
  ``packages/parity/src/producers/store/columns.ts``, kept equal by ``columns.test.ts``); rows are
  sorted by the UTF-8 bytes of their canonical JSON (= code point order).
- Excluded columns (``EXCLUDED`` below, with the reason; the run fails when a model column is in
  neither list): ``id``, ``profile_id``, device-local connector fetch state, the id-coupled hashes
  (``dedup_hash``: v2 replaces them, compared through the genesis counters) and the DERIVED columns
  whose deriving scope has not landed (transfer columns until S24, alert effective ``status`` until
  S25). Stamped derived columns (``enabled_at``, ``plan_at``, ``added_at``, ``core_changed_at``,
  ``exit_plan_changed_at``, ``acknowledged_at``, ``loans.updated_at`` ...) are compared.
- Rows read through the ORM (the run copy, migrated to head by golden.py), scoped per spec 2.4:
  ``profile_id``; through the account for the account-scoped tables; ``inv_decision_signals`` through
  the decision. A row with no profile is left out and counted (``dangling_refs`` in the index).
- Values: decimals ``format(d, "f")``; timestamps ``YYYY-MM-DDTHH:MM:SS.ffffff`` in UTC (always six
  digits, no ``Z``); dates ISO; booleans; enums by value; JSON as stored with ids rewritten (below).
- References: integer FK columns become the target's natural key (``canon.IdMap``). A reference that
  is missing or points into another profile follows gid.md 7.6 exactly as genesis does: the row is
  left out (``SKIP``: the reference a row cannot exist without) or the value becomes null (``NULL``);
  id lists drop such ids; every case counts as a dangling ref. Ids inside strings and JSON use the
  rewrite table of spec 6.5 with natural keys in place of gids: signal ``dedup_key`` parts ``i:<id>``
  / ``a:<id>`` and a whole ``alert:<id>`` key or ``rule_id`` (a dangling one becomes the canon
  ``<prefix>:dangling-<id>`` key); ``inv_signals.payload`` ``instrument_id`` / ``alert_id`` /
  ``note_id`` / ``note_ids`` / ``accounts`` (when a list; a number there is a count);
  ``inv_rule_runs.report`` ``new`` / ``escalated``; ``research_notes.details`` ``watchlist_item_id``
  / ``thesis_id`` / ``previous_instrument_id``; ``research_runs.scope`` ``instrument_ids`` /
  ``covered_instrument_ids``; ``proposals.payload`` ``account_id`` -> ``account`` and ``staged`` ->
  ``blob`` ``{sha256, ext}`` (from the file name: ``<64 hex>[-<suffix>].<ext>``; Python writes
  ``imports/<slug>/.proposals/<sha>-<random>.<ext>``); ``transactions.raw`` ``cash_leg_of`` (legs
  only). Then a guard walks every JSON value: an id-like integer under a key of canon's
  ``FIELD_TABLES`` vocabulary that no rule rewrote fails the check (``unmapped id``).
- Per-table value rules (the TS projection applies the same):
  - ``accounts.external_id``: a parked key ``<key>~<own id>`` reads ``<key>~<own natural key>``
    (parking is derived in the view, gid.md 4.3).
  - ``transactions``: cash mirror legs (``dedup_hash`` ``cashleg:...`` or ``raw.cash_leg_of`` set) are
    DERIVED rows: left out, except a leg whose ``category_source`` is ``manual_txn`` (a manual claim,
    spec 4.2). ``category`` / ``category_source`` are compared only for the claim sources
    (``sync_outbox.CLAIM_SOURCES``); rule / keyword / default / engine categories are derived on every
    device (events.md 8.3, D8) and read null until S24.
  - ``inv_import_batches.archive_path`` reads ``{sha256, ext}`` when the archive file is in the copy and
    its bytes hash to both the name's digest and ``file_sha256`` (spec 4.4), else null.
  - ``proposals.status``: ``applying`` (a device-local lock) reads ``pending`` (spec 4.10).
  - ``inv_decisions``: ``signals`` = natural keys of ``signal_id`` and every linked signal, sorted,
    dangling ones dropped; ``signal_id`` = the first of them in genesis order (``signal_id`` first,
    then linked ids ascending), it being derived (events.md 9).
- Instruments and aliases are global in Python: a profile gets the instruments of its reference
  closure (spec 4.6, D-G1) and their aliases. ``inv_notification_log`` and connector fetch state are
  in no check.
"""

from __future__ import annotations

import datetime as dt
import enum
import hashlib
import math
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import canon

from . import Check, Ctx

# table -> compared columns, in schema order. Mirrored verbatim by
# packages/parity/src/producers/store/columns.ts (keep one table per entry, strings only).
ROUNDTRIP_COLUMNS: dict[str, tuple[str, ...]] = {
    "profiles": ("slug", "name", "base_currency", "mcp_privacy", "created_at"),
    "profile_modules": ("module_id", "enabled", "enabled_at"),
    "accounts": (
        "bank",
        "name",
        "iban",
        "external_id",
        "currency",
        "type",
        "active",
        "created_at",
        "removed_at",
    ),
    "balances": ("account_id", "date", "amount", "currency", "source", "created_at"),
    "transactions": (
        "account_id",
        "booking_date",
        "value_date",
        "amount",
        "currency",
        "counterparty_name",
        "counterparty_iban",
        "description",
        "reference",
        "bank_transaction_id",
        "source",
        "occurrence",
        "category",
        "category_source",
        "raw",
        "import_batch_id",
        "created_at",
    ),
    "category_rules": ("merchant_key", "category", "source", "locked", "created_at"),
    "import_batches": (
        "source",
        "bank",
        "account_id",
        "filename",
        "started_at",
        "finished_at",
        "num_seen",
        "num_inserted",
        "num_duplicates",
        "notes",
    ),
    "loans": (
        "account_id",
        "principal",
        "annual_rate",
        "term_months",
        "start_date",
        "origination_date",
        "created_at",
        "updated_at",
        "payment_iban",
        "payment_text",
    ),
    "depreciations": (
        "account_id",
        "purchase_price",
        "purchase_date",
        "annual_rate",
        "floor",
        "created_at",
    ),
    "asset_details": ("account_id", "note", "created_at", "updated_at"),
    "inv_account_settings": (
        "account_id",
        "wrapper",
        "importer",
        "mapping_yaml",
        "created_at",
        "updated_at",
    ),
    "inv_import_batches": (
        "account_id",
        "importer",
        "broker",
        "file_name",
        "file_sha256",
        "archive_path",
        "txn_count",
        "duplicate_count",
        "position_count",
        "rename_count",
        "status_change_count",
        "instrument_count",
        "correction_count",
        "warnings",
        "created_at",
    ),
    "inv_transactions": (
        "account_id",
        "type",
        "trade_date",
        "settle_date",
        "instrument_id",
        "quantity",
        "price",
        "currency",
        "gross_amount",
        "fee",
        "tax",
        "cash_amount",
        "cash_currency",
        "fx_rate",
        "split_ratio",
        "note",
        "source",
        "import_batch_id",
        "external_ref",
        "created_at",
    ),
    "inv_position_snapshots": (
        "account_id",
        "instrument_id",
        "as_of",
        "quantity",
        "currency",
        "avg_price",
        "market_value",
        "import_batch_id",
        "created_at",
    ),
    "inv_instrument_renames": (
        "date",
        "old_instrument_id",
        "new_instrument_id",
        "note",
        "import_batch_id",
        "created_at",
    ),
    "inv_manual_valuations": (
        "instrument_id",
        "as_of",
        "unit_value",
        "currency",
        "note",
        "created_at",
    ),
    "inv_instruments": (
        "name",
        "currency",
        "asset_class",
        "symbol",
        "isin",
        "mic",
        "region",
        "sector",
        "tags",
        "needs_classification",
        "valuation_mode",
        "status",
        "created_at",
        "updated_at",
    ),
    "inv_instrument_aliases": ("instrument_id", "namespace", "value", "guessed", "created_at"),
    "inv_profile_instruments": (
        "instrument_id",
        "name",
        "asset_class",
        "tags",
        "region",
        "sector",
        "valuation_mode",
        "status",
        "needs_classification",
        "created_at",
        "updated_at",
        "plan",
        "plan_at",
        "plan_reason",
        "segment",
        "segment_by",
    ),
    "inv_strategy_versions": (
        "version",
        "sha256",
        "yaml_text",
        "md_text",
        "state",
        "issues",
        "created_at",
    ),
    "inv_theses": (
        "instrument_id",
        "entry_type",
        "thesis",
        "invalidation",
        "exit_plan",
        "size_plan",
        "reviewed_at",
        "created_at",
        "updated_at",
        "core_changed_at",
        "exit_plan_changed_at",
    ),
    "inv_topic_theses": (
        "segment",
        "thesis",
        "invalidation",
        "draft",
        "created_by",
        "core_changed_at",
        "created_at",
        "updated_at",
        "rejected_at",
        "assessment",
        "outlook",
        "view_updated_at",
        "view_sources",
    ),
    "watchlist_items": ("instrument_id", "note", "tags", "source", "added_at", "removed_at"),
    "alerts": (
        "instrument_id",
        "scope",
        "kind",
        "params",
        "polarity",
        "severity",
        "title",
        "note",
        "source",
        "created_by",
        "cooldown_days",
        "expires_at",
        "status",
        "snoozed_until",
        "last_triggered_at",
        "last_checked_at",
        "last_value",
        "created_at",
        "updated_at",
        "deleted_at",
    ),
    "inv_planned_deposits": (
        "account_id",
        "amount",
        "currency",
        "planned_date",
        "note",
        "status",
        "booked_txn_id",
        "booked_at",
        "created_at",
        "updated_at",
    ),
    "inv_signals": (
        "rule_id",
        "kind",
        "dedup_key",
        "severity",
        "status",
        "message",
        "instrument_id",
        "account_id",
        "payload",
        "first_seen_at",
        "last_seen_at",
        "created_run_id",
        "last_run_id",
        "acknowledged_at",
        "closed_at",
        "polarity",
        "snoozed_until",
    ),
    "inv_rule_runs": (
        "trigger",
        "as_of",
        "status",
        "strategy_version_id",
        "stats",
        "errors",
        "report",
        "started_at",
        "finished_at",
    ),
    "inv_decisions": (
        "signal_id",
        "instrument_id",
        "account_id",
        "action",
        "quantity",
        "price",
        "currency",
        "reason",
        "created_at",
        "signals",
    ),
    "reviews": ("module", "done_at", "notes", "stats"),
    "proposals": (
        "kind",
        "status",
        "summary",
        "reason",
        "payload",
        "result",
        "source",
        "created_at",
        "reviewed_at",
    ),
    "research_runs": ("started_at", "finished_at", "status", "scope", "counts", "created_by"),
    "research_notes": (
        "run_id",
        "instrument_id",
        "theme",
        "kind",
        "polarity",
        "strength",
        "thesis_relation",
        "thesis_field",
        "title",
        "summary",
        "sources",
        "details",
        "candidate_key",
        "signal_id",
        "observed_at",
        "expires_at",
        "created_by",
        "dismissed_at",
        "cooldown_until",
        "created_at",
        "updated_at",
        "read_at",
        "segment",
    ),
    "connector_bindings": (
        "account_id",
        "connector_id",
        "params_json",
        "auto_commit",
        "cursor",
        "created_at",
        "updated_at",
    ),
}

_ID = "row id: the TS side has gids; references compare as natural keys"
_PROFILE = "the vault is the profile"
_DERIVED_S24 = "DERIVED (events.md 9), compared once S24 derives it"

# table -> column -> why it is not compared. Every model column is in ROUNDTRIP_COLUMNS or here.
EXCLUDED: dict[str, dict[str, str]] = {
    "profiles": {"id": _ID},
    "profile_modules": {"profile_id": _PROFILE},
    "accounts": {"id": _ID, "profile_id": _PROFILE},
    "balances": {"id": _ID},
    "transactions": {
        "id": _ID,
        "dedup_hash": "id-coupled hash: v2 replaces it, compared through the genesis counters",
        "transfer_group_id": _DERIVED_S24,
        "is_internal_transfer": _DERIVED_S24,
    },
    "category_rules": {"id": _ID, "profile_id": _PROFILE},
    "import_batches": {"id": _ID, "profile_id": _PROFILE},
    "loans": {"id": _ID},
    "depreciations": {"id": _ID},
    "asset_details": {"id": _ID},
    "inv_account_settings": {},
    "inv_import_batches": {"id": _ID, "profile_id": _PROFILE},
    "inv_transactions": {
        "id": _ID,
        "dedup_hash": "id-coupled hash: v2 replaces it, compared through the genesis counters",
    },
    "inv_position_snapshots": {"id": _ID},
    "inv_instrument_renames": {"id": _ID, "profile_id": _PROFILE},
    "inv_manual_valuations": {"id": _ID, "profile_id": _PROFILE},
    "inv_instruments": {"id": _ID},
    "inv_instrument_aliases": {"id": _ID},
    "inv_profile_instruments": {"id": _ID, "profile_id": _PROFILE},
    "inv_strategy_versions": {"id": _ID, "profile_id": _PROFILE},
    "inv_theses": {"id": _ID, "profile_id": _PROFILE},
    "inv_topic_theses": {"id": _ID, "profile_id": _PROFILE},
    "watchlist_items": {"id": _ID, "profile_id": _PROFILE},
    "alerts": {"id": _ID, "profile_id": _PROFILE},
    "inv_planned_deposits": {"id": _ID, "profile_id": _PROFILE},
    "inv_signals": {"id": _ID, "profile_id": _PROFILE},
    "inv_rule_runs": {"id": _ID, "profile_id": _PROFILE},
    "inv_decisions": {"id": _ID, "profile_id": _PROFILE},
    "reviews": {"id": _ID, "profile_id": _PROFILE},
    "proposals": {"id": _ID, "profile_id": _PROFILE},
    "research_runs": {"id": _ID, "profile_id": _PROFILE},
    "research_notes": {"id": _ID, "profile_id": _PROFILE},
    "connector_bindings": {
        "id": _ID,
        "profile_id": _PROFILE,
        "last_run_at": "device-local fetch state (events.md 10)",
        "last_status": "device-local fetch state (events.md 10)",
        "last_ok_at": "device-local fetch state (events.md 10)",
        "backoff_until": "device-local fetch state (events.md 10)",
    },
}

# Compared values that are no model column.
PSEUDO_COLUMNS: dict[str, frozenset[str]] = {"inv_decisions": frozenset({"signals"})}

EMBEDDED = "inv_decision_signals"  # synced, but carried by inv_decisions
ACCOUNT_SCOPED = frozenset(
    {
        "balances",
        "transactions",
        "loans",
        "depreciations",
        "asset_details",
        "inv_account_settings",
        "inv_transactions",
        "inv_position_snapshots",
    }
)
GLOBAL = frozenset({"inv_instruments", "inv_instrument_aliases"})

SKIP = "skip"  # gid.md 7.6: the row is left out
NULL = "null"  # gid.md 7.6: the reference reads null

# table -> FK column -> (referenced table, rule when it dangles). gid.md 7.6.
REFS: dict[str, dict[str, tuple[str, str]]] = {
    "balances": {"account_id": ("accounts", SKIP)},
    "transactions": {
        "account_id": ("accounts", SKIP),
        "import_batch_id": ("import_batches", NULL),
    },
    "import_batches": {"account_id": ("accounts", NULL)},
    "loans": {"account_id": ("accounts", SKIP)},
    "depreciations": {"account_id": ("accounts", SKIP)},
    "asset_details": {"account_id": ("accounts", SKIP)},
    "inv_account_settings": {"account_id": ("accounts", SKIP)},
    "inv_import_batches": {"account_id": ("accounts", SKIP)},
    "inv_transactions": {
        "account_id": ("accounts", SKIP),
        "instrument_id": ("inv_instruments", NULL),
        "import_batch_id": ("inv_import_batches", NULL),
    },
    "inv_position_snapshots": {
        "account_id": ("accounts", SKIP),
        "instrument_id": ("inv_instruments", SKIP),
        "import_batch_id": ("inv_import_batches", NULL),
    },
    "inv_instrument_renames": {
        "old_instrument_id": ("inv_instruments", SKIP),
        "new_instrument_id": ("inv_instruments", SKIP),
        "import_batch_id": ("inv_import_batches", NULL),
    },
    "inv_manual_valuations": {"instrument_id": ("inv_instruments", SKIP)},
    "inv_instrument_aliases": {"instrument_id": ("inv_instruments", SKIP)},
    "inv_profile_instruments": {"instrument_id": ("inv_instruments", SKIP)},
    "inv_theses": {"instrument_id": ("inv_instruments", SKIP)},
    "watchlist_items": {"instrument_id": ("inv_instruments", SKIP)},
    "alerts": {"instrument_id": ("inv_instruments", NULL)},
    "inv_planned_deposits": {
        "account_id": ("accounts", NULL),
        "booked_txn_id": ("inv_transactions", NULL),
    },
    "inv_signals": {
        "instrument_id": ("inv_instruments", NULL),
        "account_id": ("accounts", NULL),
        "created_run_id": ("inv_rule_runs", NULL),
        "last_run_id": ("inv_rule_runs", NULL),
    },
    "inv_rule_runs": {"strategy_version_id": ("inv_strategy_versions", NULL)},
    "inv_decisions": {
        "instrument_id": ("inv_instruments", NULL),
        "account_id": ("accounts", NULL),
    },
    "research_notes": {
        "run_id": ("research_runs", NULL),
        "instrument_id": ("inv_instruments", NULL),
        "signal_id": ("inv_signals", NULL),
    },
    "connector_bindings": {"account_id": ("accounts", SKIP)},
}

# The tables a reference can point at: their rows of the profile (instruments: the closure).
_TARGETS = frozenset(
    {
        "accounts",
        "transactions",
        "import_batches",
        "inv_import_batches",
        "inv_transactions",
        "inv_signals",
        "inv_rule_runs",
        "inv_strategy_versions",
        "research_runs",
        "research_notes",
        "alerts",
        "inv_theses",
        "watchlist_items",
    }
)

_DIGITS = re.compile(r"[0-9]+")
_KEY_PART = re.compile(r"(i|a):([0-9]+)")
_ALERT_KEY = re.compile(r"alert:([0-9]+)")
_STAGED = re.compile(r"([0-9a-f]{64})(?:-[0-9A-Za-z]+)?\.([A-Za-z0-9]{1,10})")
_ARCHIVE = re.compile(r"([0-9a-f]{64})\.([A-Za-z0-9]{1,10})")
_EXT = re.compile(r"[a-z0-9]{1,10}")


def _row_id(value: Any) -> int | None:
    """An integer row id (or its digit string, as payloads store some), else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and _DIGITS.fullmatch(value) and not value.startswith("0"):
        return int(value)
    return None


# --------------------------------------------------------------------------- #
# Rows and scoping (read once per run)
# --------------------------------------------------------------------------- #


@dataclass
class _Source:
    rows: dict[str, list[dict]]  # table -> every row (column name -> ORM value), key order
    by_profile: dict[str, dict[int, list[dict]]]  # table -> profile id -> rows
    unscoped: dict[str, int]  # table -> rows no profile owns
    owned: dict[int, dict[str, set[int]]]  # profile id -> target table -> ids


def _mappers() -> dict[str, Any]:
    from sqlmodel.main import default_registry

    return {
        m.class_.__tablename__: m
        for m in default_registry.mappers
        if isinstance(getattr(m.class_, "__tablename__", None), str)
    }


def _read(ctx: Ctx) -> dict[str, list[dict]]:
    from sqlalchemy import select

    mappers = _mappers()
    out: dict[str, list[dict]] = {}
    for table in [*ROUNDTRIP_COLUMNS, EMBEDDED]:
        mapper = mappers[table]
        attrs = [(a.columns[0].name, a.key) for a in mapper.column_attrs]
        stmt = select(mapper.class_).order_by(*mapper.primary_key)
        objs = ctx.session.execute(stmt).scalars().all()
        out[table] = [{col: getattr(o, key) for col, key in attrs} for o in objs]
    return out


def _guard_schema(ctx: Ctx) -> None:
    """The synced table set and every model column are accounted for (names only, never values)."""
    from cashu.core.sync_outbox import SPECS

    expected = set(SPECS) - {EMBEDDED}
    if set(ROUNDTRIP_COLUMNS) != expected:
        raise RuntimeError(
            f"synced tables changed: missing {sorted(expected - set(ROUNDTRIP_COLUMNS))}, "
            f"extra {sorted(set(ROUNDTRIP_COLUMNS) - expected)}"
        )
    mappers = _mappers()
    for table, columns in ROUNDTRIP_COLUMNS.items():
        model = {a.columns[0].name for a in mappers[table].column_attrs}
        listed = (set(columns) - PSEUDO_COLUMNS.get(table, frozenset())) | set(EXCLUDED[table])
        if model != listed:
            raise RuntimeError(
                f"{table}: columns not accounted for {sorted(model - listed)}, "
                f"listed but absent {sorted(listed - model)}"
            )


def _source(ctx: Ctx) -> _Source:
    cached = ctx.cache.get("store.source")
    if cached is not None:
        return cached
    _guard_schema(ctx)
    rows = _read(ctx)
    profile_ids = {r["id"] for r in rows["profiles"]}
    account_profile = {r["id"]: r["profile_id"] for r in rows["accounts"]}
    decision_profile = {r["id"]: r["profile_id"] for r in rows["inv_decisions"]}

    def profile_of(table: str, row: dict) -> int | None:
        if table == "profiles":
            return row["id"]
        if table in ACCOUNT_SCOPED:
            return account_profile.get(row["account_id"])
        if table == EMBEDDED:
            return decision_profile.get(row["decision_id"])
        return row["profile_id"]

    by_profile: dict[str, dict[int, list[dict]]] = {}
    unscoped: dict[str, int] = {}
    for table, table_rows in rows.items():
        if table in GLOBAL:
            continue
        per: dict[int, list[dict]] = {pid: [] for pid in profile_ids}
        lost = 0
        for row in table_rows:
            pid = profile_of(table, row)
            if pid in per:
                per[pid].append(row)
            else:
                lost += 1
        by_profile[table] = per
        unscoped[table] = lost

    instrument_ids = {r["id"] for r in rows["inv_instruments"]}
    owned: dict[int, dict[str, set[int]]] = {}
    for pid in profile_ids:
        mine = {t: {r["id"] for r in by_profile[t][pid]} for t in _TARGETS}
        mine["inv_instruments"] = _closure(by_profile, pid) & instrument_ids
        owned[pid] = mine
    source = _Source(rows, by_profile, unscoped, owned)
    ctx.cache["store.source"] = source
    return source


def _closure(by_profile: dict[str, dict[int, list[dict]]], pid: int) -> set[int]:
    """Instrument ids the profile's rows reference (spec 4.6, D-G1)."""
    found: set[int] = set()

    def add(value: Any) -> None:
        row_id = _row_id(value)
        if row_id is not None:
            found.add(row_id)

    def add_all(values: Any) -> None:
        if isinstance(values, list):
            for v in values:
                add(v)

    def rows(table: str) -> list[dict]:
        return by_profile[table][pid]

    for table in (
        "inv_transactions",
        "inv_position_snapshots",
        "inv_manual_valuations",
        "inv_profile_instruments",
        "inv_theses",
        "alerts",
        "watchlist_items",
        "inv_decisions",
    ):
        for r in rows(table):
            add(r["instrument_id"])
    for r in rows("inv_instrument_renames"):
        add(r["old_instrument_id"])
        add(r["new_instrument_id"])
    for r in rows("inv_signals"):
        add(r["instrument_id"])
        for part in (r["dedup_key"] or "").split("|"):
            m = _KEY_PART.fullmatch(part)
            if m and m[1] == "i":
                found.add(int(m[2]))
        if isinstance(r["payload"], dict):
            add(r["payload"].get("instrument_id"))
    for r in rows("research_notes"):
        add(r["instrument_id"])
        if isinstance(r["details"], dict):
            add(r["details"].get("previous_instrument_id"))
    for r in rows("research_runs"):
        if isinstance(r["scope"], dict):
            add_all(r["scope"].get("instrument_ids"))
            add_all(r["scope"].get("covered_instrument_ids"))
    return found


# --------------------------------------------------------------------------- #
# One profile's references
# --------------------------------------------------------------------------- #


class _Dangling(Exception):
    """A SKIP reference dangles: the row is left out."""


class _Refs:
    def __init__(self, ctx: Ctx, owned: dict[str, set[int]]) -> None:
        self.ctx = ctx
        self.owned = owned

    def _lost(self) -> None:
        self.ctx.ids.dangling += 1

    def key(self, table: str, row_id: int) -> str | None:
        if row_id in self.owned[table]:
            return self.ctx.ids.key(table, row_id)
        self._lost()
        return None

    def column(self, table: str, value: Any, rule: str) -> str | None:
        if value is None:
            return None
        found = self.key(table, int(value))
        if found is None and rule == SKIP:
            raise _Dangling
        return found

    def scalar(self, table: str, value: Any) -> Any:
        """A JSON scalar id: natural key, null when it dangles; a non-id value stays."""
        row_id = _row_id(value)
        return value if row_id is None else self.key(table, row_id)

    def ids(self, table: str, values: Any) -> Any:
        """A JSON id list: natural keys, dangling ids dropped; non-id items stay."""
        if not isinstance(values, list):
            return values
        out = []
        for v in values:
            row_id = _row_id(v)
            if row_id is None:
                out.append(v)
                continue
            found = self.key(table, row_id)
            if found is not None:
                out.append(found)
        return out

    def key_part(self, table: str, row_id: int) -> str:
        """An id inside a key string: a dangling one keeps a stable placeholder (gid.md 7.6)."""
        if row_id in self.owned[table]:
            return self.ctx.ids.key(table, row_id)
        self._lost()
        return f"{canon.SPECS[table][0]}:dangling-{row_id}"

    def rule_key(self, value: str | None, whole_alert_only: bool) -> str | None:
        """Signal ``dedup_key`` / ``rule_id`` with ids as natural keys (spec 6.5)."""
        if value is None:
            return None
        m = _ALERT_KEY.fullmatch(value)
        if m:
            return "alert:" + self.key_part("alerts", int(m[1]))
        if whole_alert_only:
            return value
        parts = []
        for part in value.split("|"):
            m = _KEY_PART.fullmatch(part)
            if m:
                table = "inv_instruments" if m[1] == "i" else "accounts"
                parts.append(f"{m[1]}:" + self.key_part(table, int(m[2])))
            else:
                parts.append(part)
        return "|".join(parts)


# --------------------------------------------------------------------------- #
# Values
# --------------------------------------------------------------------------- #


def _timestamp(value: dt.datetime) -> str:
    if value.tzinfo is not None:
        value = value.astimezone(dt.UTC).replace(tzinfo=None)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f")


def _json(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, dict):
        return {str(k): _json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json(v) for v in value]
    raise TypeError(f"no canonical JSON form for {type(value).__name__}")


def _value(value: Any) -> Any:
    if isinstance(value, enum.Enum):
        return _value(value.value)
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dt.datetime):
        return _timestamp(value)
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, (dict, list, float)):
        return _json(value)
    raise TypeError(f"no canonical form for {type(value).__name__}")


def _vocabulary_table(key: str) -> str | None:
    """canon's id-field vocabulary (``FIELD_TABLES`` plus its ``*_instrument_id(s)`` suffixes)."""
    found = canon.FIELD_TABLES.get(key)
    if found is None:
        for suffix in ("instrument_id", "signal_id", "account_id", "alert_id", "note_id"):
            if key.endswith((f"_{suffix}", f"_{suffix}s")):
                return canon.FIELD_TABLES[suffix]
    return found


def _guard_json(value: Any, path: str) -> None:
    """Fail on an id-like integer under an id key no rewrite rule handled (spec 6.5 guard)."""
    if isinstance(value, dict):
        for k, v in value.items():
            sub = f"{path}.{k}"
            if _vocabulary_table(str(k)) is not None:
                items = v if isinstance(v, list) else [v]
                if any(_row_id(i) is not None for i in items):
                    raise canon.UnmappedId(sub)
            _guard_json(v, sub)
    elif isinstance(value, list):
        for v in value:
            _guard_json(v, f"{path}[]")


def _blob(name: Any, pattern: re.Pattern[str]) -> dict | None:
    if not isinstance(name, str):
        return None
    m = pattern.fullmatch(name.rsplit("/", 1)[-1])
    if m is None or not _EXT.fullmatch(m[2].lower()):
        return None
    return {"sha256": m[1], "ext": m[2].lower()}


def _archive(ctx: Ctx, row: dict) -> dict | None:
    """``inv_import_batches.archive_path`` as genesis exports it (spec 4.4), else null (counted)."""
    from cashu.core import paths

    path = row["archive_path"]
    if path is None:
        return None
    blob = _blob(path, _ARCHIVE)
    file = Path(path) if Path(path).is_absolute() else paths.data_dir() / path
    if (
        blob is None
        or blob["sha256"] != row["file_sha256"]
        or not file.is_file()
        or hashlib.sha256(file.read_bytes()).hexdigest() != blob["sha256"]
    ):
        ctx.ids.dangling += 1
        return None
    return blob


# --------------------------------------------------------------------------- #
# JSON rewrites (spec 6.5, natural keys in place of gids)
# --------------------------------------------------------------------------- #


def _payload(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    for k, table in (
        ("instrument_id", "inv_instruments"),
        ("alert_id", "alerts"),
        ("note_id", "research_notes"),
    ):
        if k in out:
            out[k] = refs.scalar(table, out[k])
    if "note_ids" in out:
        out["note_ids"] = refs.ids("research_notes", out["note_ids"])
    if isinstance(out.get("accounts"), list):
        out["accounts"] = refs.ids("accounts", out["accounts"])
    return out


def _report(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    for k in ("new", "escalated"):
        if k in out:
            out[k] = refs.ids("inv_signals", out[k])
    return out


def _details(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    for k, table in (
        ("watchlist_item_id", "watchlist_items"),
        ("thesis_id", "inv_theses"),
        ("previous_instrument_id", "inv_instruments"),
    ):
        if k in out:
            out[k] = refs.scalar(table, out[k])
    return out


def _scope(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    for k in ("instrument_ids", "covered_instrument_ids"):
        if k in out:
            out[k] = refs.ids("inv_instruments", out[k])
    return out


def _proposal_payload(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    if "account_id" in out:
        out["account"] = refs.scalar("accounts", out.pop("account_id"))
    if "staged" in out:
        staged = out.pop("staged")
        out["blob"] = _blob(staged, _STAGED)
        if out["blob"] is None and staged is not None:
            refs._lost()
    return out


def _raw(refs: _Refs, value: Any) -> Any:
    if not isinstance(value, dict) or "cash_leg_of" not in value:
        return value
    out = dict(value)
    out["cash_leg_of"] = refs.scalar("transactions", out["cash_leg_of"])
    return out


# (table, column) -> rewrite; every other JSON column goes through the guard only.
_JSON_RULES = {
    ("inv_signals", "payload"): _payload,
    ("inv_rule_runs", "report"): _report,
    ("research_notes", "details"): _details,
    ("research_runs", "scope"): _scope,
    ("proposals", "payload"): _proposal_payload,
    ("transactions", "raw"): _raw,
}


# --------------------------------------------------------------------------- #
# Rows
# --------------------------------------------------------------------------- #


def _cash_leg(row: dict) -> bool:
    raw = row["raw"]
    return str(row["dedup_hash"] or "").startswith("cashleg:") or (
        isinstance(raw, dict) and raw.get("cash_leg_of") is not None
    )


def _decision_signals(refs: _Refs, row: dict, links: list[int]) -> list[str]:
    """``signal_id`` first, then the linked ids ascending (genesis order), as natural keys."""
    order = ([row["signal_id"]] if row["signal_id"] is not None else []) + sorted(links)
    keys: list[str] = []
    for signal_id in dict.fromkeys(order):
        found = refs.key("inv_signals", signal_id)
        if found is not None:
            keys.append(found)
    return keys


def _naive_utc(t: dt.datetime) -> dt.datetime:
    return t if t.tzinfo is None else t.astimezone(dt.UTC).replace(tzinfo=None)


def _effective_alert(row: dict, as_of: dt.date) -> tuple[str, dt.datetime | None]:
    """The alert status and snooze end a reader shows at ``as_of`` 00:00 UTC (lead decision: the
    effective status is compared on both sides, TS ``effectiveAlertStatus``; mirrors
    ``service/alerts.py:housekeeping``, ``<=`` at both boundaries, a muted alert never expires)."""
    status, until, expires = row["status"], row["snoozed_until"], row["expires_at"]
    if status == "muted":
        return status, until
    now = dt.datetime.combine(as_of, dt.time())
    if expires is not None and _naive_utc(expires) <= now:
        return "expired", None
    if status == "snoozed" and until is not None and _naive_utc(until) <= now:
        return "active", None
    return status, until


def _project(ctx: Ctx, refs: _Refs, table: str, row: dict, extra: dict) -> dict | None:
    """The canonical row, or None when it is left out (a derived row, a dangling SKIP ref)."""
    from cashu.core.sync_outbox import CLAIM_SOURCES

    row = dict(row)
    if table == "transactions":
        if _cash_leg(row) and row["category_source"] != "manual_txn":
            return None  # a derived cash mirror leg
        if row["category_source"] not in CLAIM_SOURCES:
            row["category"] = row["category_source"] = None
    elif table == "accounts":
        ext = row["external_id"]
        if isinstance(ext, str) and ext.endswith(f"~{row['id']}"):
            row["external_id"] = (
                ext[: -len(f"~{row['id']}")] + "~" + ctx.ids.key("accounts", row["id"])
            )
    elif table == "alerts":
        row["status"], row["snoozed_until"] = _effective_alert(row, ctx.as_of)
    elif table == "proposals" and row["status"] == "applying":
        row["status"] = "pending"
    elif table == "inv_signals":
        row["dedup_key"] = refs.rule_key(row["dedup_key"], whole_alert_only=False)
        row["rule_id"] = refs.rule_key(row["rule_id"], whole_alert_only=True)
    elif table == "inv_import_batches":
        row["archive_path"] = _archive(ctx, row)
    elif table == "inv_decisions":
        signals = _decision_signals(refs, row, extra.get(row["id"], []))
        row["signal_id"] = signals[0] if signals else None
        row["signals"] = sorted(signals, key=lambda k: k.encode("utf-8"))

    try:
        for col, (target, rule) in REFS.get(table, {}).items():
            row[col] = refs.column(target, row[col], rule)
    except _Dangling:
        return None

    out = {}
    for col in ROUNDTRIP_COLUMNS[table]:
        value = row[col]
        rule = _JSON_RULES.get((table, col))
        if rule is not None:
            value = rule(refs, value)
        value = _value(value)
        if isinstance(value, (dict, list)):
            _guard_json(value, f"{table}.{col}")
        out[col] = value
    return out


def _table_rows(ctx: Ctx, source: _Source, table: str, pid: int) -> list[dict]:
    if table == "inv_instruments":
        closure = source.owned[pid]["inv_instruments"]
        return [r for r in source.rows[table] if r["id"] in closure]
    if table == "inv_instrument_aliases":
        closure = source.owned[pid]["inv_instruments"]
        return [r for r in source.rows[table] if r["instrument_id"] in closure]
    return source.by_profile[table][pid]


def _table_check(table: str):
    def run(ctx: Ctx) -> dict:
        source = _source(ctx)
        ctx.ids.dangling += source.unscoped.get(table, 0)
        extra: dict[int, list[int]] = {}
        if table == "inv_decisions":
            for link in source.rows[EMBEDDED]:
                extra.setdefault(link["decision_id"], []).append(link["signal_id"])
        out = {}
        for p in ctx.profiles:
            refs = _Refs(ctx, source.owned[p.id])
            rows = []
            for row in _table_rows(ctx, source, table, p.id):
                projected = _project(ctx, refs, table, row, extra)
                if projected is not None:
                    rows.append(projected)
            rows.sort(key=lambda r: canon.dumps(r).encode("utf-8"))
            out[ctx.pkey(p)] = rows
        return {"profiles": out}

    run.__name__ = f"store_table_{table}"
    return run


@dataclass(frozen=True)
class TableCheck(Check):
    """A check whose output is canonical already (ids are natural keys, values canonical strings):
    canon's id inference must not run over it (``external_id``, ``bank_transaction_id`` and bank
    ``raw`` keys are no row ids). Rows = the number of profiles, as the TS producer CLI counts it."""

    def run(self, ctx: Ctx) -> tuple[Any, int]:
        data = self.fn(ctx)
        return data, len(data["profiles"])


CHECKS = [TableCheck(f"store.table.{t}", _table_check(t)) for t in ROUNDTRIP_COLUMNS]
