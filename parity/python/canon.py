"""Canonical JSON of the golden outputs and the natural keys that replace integer row ids.

Canonical form (the TS comparer, S03, parses the same rules):
- ``json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`` + a trailing newline;
- ``Decimal`` -> string exactly as Python's ``str()`` (``"1E+1"``, ``"0.00"``, ``"-0"`` kept as is);
- ``date`` -> ``YYYY-MM-DD``; ``datetime`` -> ``isoformat()`` (naive stays naive, aware keeps its offset);
- floats stay JSON numbers (Python ``repr``); NaN / Infinity -> the strings ``"NaN"`` / ``"Infinity"`` /
  ``"-Infinity"``;
- enums -> their value; tuples -> lists; sets / frozensets -> sorted lists; dataclasses -> objects of
  their fields; MCP ``Labelled`` leaves -> ``{"$label": <label>, "value": <value>}``;
- integer row ids -> natural keys (see :class:`IdMap` and ``FIELD_TABLES`` / ``PARENT_TABLES``).
  An id-like field (``id``, ``*_id``, ``*_ids``) holding an integer the rules cannot place raises
  :class:`UnmappedId`, so a new id never slips into a golden file unnoticed.

Natural keys are ``<prefix>:<first 16 hex of sha256(parts joined by U+001F)>``; the parts per table are
in ``SPECS`` (references to other tables use that table's natural key). Two rows with equal parts get
``~2``, ``~3`` ... in id order. Hashing keeps real names and numbers out of the keys, so a JSON path in
a comparer report never shows data.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import enum
import hashlib
import json
import math
from decimal import Decimal
from typing import Any

from sqlalchemy import text

# table -> (prefix, SQL selecting the id then the key parts, reference table per part or None)
SPECS: dict[str, tuple[str, str, tuple[str | None, ...]]] = {
    "profiles": ("profile", "SELECT id, slug FROM profiles", (None,)),
    "accounts": (
        "account",
        (
            "SELECT id, profile_id, bank, coalesce(external_id, ''), type, currency, "
            "CASE WHEN external_id IS NULL THEN name ELSE '' END FROM accounts"
        ),
        ("profiles", None, None, None, None, None),
    ),
    "inv_instruments": (
        "instrument",
        (
            "SELECT id, coalesce(isin, ''), coalesce(symbol, ''), coalesce(mic, ''), currency, "
            "name FROM inv_instruments"
        ),
        (None, None, None, None, None),
    ),
    "inv_signals": (
        "signal",
        "SELECT id, profile_id, rule_id, dedup_key, first_seen_at FROM inv_signals",
        ("profiles", None, None, None),
    ),
    "alerts": (
        "alert",
        "SELECT id, profile_id, created_at, kind, instrument_id FROM alerts",
        ("profiles", None, None, "inv_instruments"),
    ),
    "inv_theses": (
        "thesis",
        "SELECT id, profile_id, instrument_id, created_at FROM inv_theses",
        ("profiles", "inv_instruments", None),
    ),
    "inv_topic_theses": (
        "topic-thesis",
        "SELECT id, profile_id, segment FROM inv_topic_theses",
        ("profiles", None),
    ),
    "research_runs": (
        "research-run",
        "SELECT id, profile_id, started_at FROM research_runs",
        ("profiles", None),
    ),
    "research_notes": (
        "note",
        "SELECT id, profile_id, run_id, created_at, title FROM research_notes",
        ("profiles", "research_runs", None, None),
    ),
    "inv_decisions": (
        "decision",
        "SELECT id, profile_id, created_at, action, instrument_id FROM inv_decisions",
        ("profiles", None, None, "inv_instruments"),
    ),
    "inv_transactions": (
        "inv-txn",
        "SELECT id, account_id, dedup_hash FROM inv_transactions",
        ("accounts", None),
    ),
    "transactions": (
        "txn",
        "SELECT id, account_id, dedup_hash, occurrence FROM transactions",
        ("accounts", None, None),
    ),
    "inv_import_batches": (
        "inv-import",
        "SELECT id, profile_id, account_id, file_sha256, created_at FROM inv_import_batches",
        ("profiles", "accounts", None, None),
    ),
    "import_batches": (
        "import",
        "SELECT id, profile_id, started_at, coalesce(filename, '') FROM import_batches",
        ("profiles", None, None),
    ),
    "loans": ("loan", "SELECT id, account_id FROM loans", ("accounts",)),
    "depreciations": ("depreciation", "SELECT id, account_id FROM depreciations", ("accounts",)),
    "asset_details": ("asset-detail", "SELECT id, account_id FROM asset_details", ("accounts",)),
    "inv_strategy_versions": (
        "strategy-version",
        "SELECT id, profile_id, version FROM inv_strategy_versions",
        ("profiles", None),
    ),
    "watchlist_items": (
        "watch",
        "SELECT id, profile_id, instrument_id FROM watchlist_items",
        ("profiles", "inv_instruments"),
    ),
    "proposals": (
        "proposal",
        "SELECT id, profile_id, created_at, kind FROM proposals",
        ("profiles", None, None),
    ),
    "inv_rule_runs": (
        "rule-run",
        "SELECT id, profile_id, started_at, trigger FROM inv_rule_runs",
        ("profiles", None, None),
    ),
    "reviews": (
        "review",
        "SELECT id, profile_id, module, done_at FROM reviews",
        ("profiles", None, None),
    ),
    "inv_manual_valuations": (
        "manual-valuation",
        "SELECT id, profile_id, instrument_id, as_of FROM inv_manual_valuations",
        ("profiles", "inv_instruments", None),
    ),
    "category_rules": (
        "category-rule",
        "SELECT id, profile_id, merchant_key FROM category_rules",
        ("profiles", None),
    ),
    "balances": (
        "balance",
        "SELECT id, account_id, date, source FROM balances",
        ("accounts", None, None),
    ),
    "inv_planned_deposits": (
        "planned-deposit",
        "SELECT id, profile_id, created_at, planned_date FROM inv_planned_deposits",
        ("profiles", None, None),
    ),
    "inv_position_snapshots": (
        "position-snapshot",
        "SELECT id, account_id, instrument_id, as_of FROM inv_position_snapshots",
        ("accounts", "inv_instruments", None),
    ),
    "connectors": ("connector", "SELECT id, name FROM connectors", (None,)),
}

# Field name -> table of the integer (or digit string) it holds; lists of them too.
FIELD_TABLES: dict[str, str] = {
    "profile_id": "profiles",
    "account_id": "accounts",
    "account_ids": "accounts",
    "instrument_id": "inv_instruments",
    "instrument_ids": "inv_instruments",
    "old_instrument_id": "inv_instruments",
    "new_instrument_id": "inv_instruments",
    "signal_id": "inv_signals",
    "signal_ids": "inv_signals",
    "alert_id": "alerts",
    "alert_ids": "alerts",
    "thesis_id": "inv_theses",
    "topic_thesis_id": "inv_topic_theses",
    "note_id": "research_notes",
    "note_ids": "research_notes",
    "decision_id": "inv_decisions",
    "decision_ids": "inv_decisions",
    "loan_id": "loans",
    "version_id": "inv_strategy_versions",
    "strategy_version_id": "inv_strategy_versions",
    "proposal_id": "proposals",
    "deposit_id": "inv_planned_deposits",
    "review_id": "reviews",
    "valuation_id": "inv_manual_valuations",
    "created_run_id": "inv_rule_runs",
    "last_run_id": "inv_rule_runs",
    "rule_run_id": "inv_rule_runs",
    "research_run_id": "research_runs",
    "new_signal_ids": "inv_signals",
    "open_txn_id": "inv_transactions",
    "close_txn_id": "inv_transactions",
    "batch_id": "inv_import_batches",
    "import_batch_id": "inv_import_batches",
    "item_id": "watchlist_items",
    "run_id": "research_runs",
    "running_run_id": "research_runs",
    "watchlist_item_id": "watchlist_items",
    "watch_item_id": "watchlist_items",
}

# Parent field name -> table of a bare ``id`` inside it (the object itself or the list's items).
PARENT_TABLES: dict[str, str] = {
    "instrument": "inv_instruments",
    "instruments": "inv_instruments",
    "account": "accounts",
    "accounts": "accounts",
    "signal": "inv_signals",
    "signals": "inv_signals",
    "alert": "alerts",
    "alerts": "alerts",
    "thesis": "inv_theses",
    "theses": "inv_theses",
    "topic_theses": "inv_topic_theses",
    "decision": "inv_decisions",
    "decisions": "inv_decisions",
    "note": "research_notes",
    "notes": "research_notes",
    "last_run": "inv_rule_runs",
    "runs": "inv_rule_runs",
    "loan": "loans",
    "loans": "loans",
    "versions": "inv_strategy_versions",
    "manual_valuations": "inv_manual_valuations",
    "planned_deposits": "inv_planned_deposits",
    "watchlist": "watchlist_items",
    "proposals": "proposals",
    "reviews": "reviews",
    "last_review": "reviews",
    "imports": "inv_import_batches",
    "batches": "inv_import_batches",
    "transactions": "inv_transactions",
}


# (absolute prefix, placeholder): run-specific paths in strings (strategy file paths ...) are
# replaced, so two runs on different copies give the same bytes. Set by the golden child.
PATH_ALIASES: list[tuple[str, str]] = []


class UnmappedId(RuntimeError):
    """An id-like field holds an integer no rule maps; ``path`` names fields only, never values."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        self.path = path


def _digest(parts: list[str]) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


class IdMap:
    """Natural keys of every row of the tables in ``SPECS``, built once per run."""

    def __init__(self, session) -> None:
        self._keys: dict[str, dict[int, str]] = {}
        self.dangling = 0  # references to rows that do not exist (counted per check in the index)
        for table, (prefix, sql, refs) in SPECS.items():
            rows = session.exec(text(sql)).all()
            built: dict[int, str] = {}
            seen: dict[str, int] = {}
            for row in sorted(rows, key=lambda r: r[0]):
                parts = []
                for ref, value in zip(refs, row[1:], strict=True):
                    if ref is not None and value is not None:
                        parts.append(self.key(ref, int(value)))
                    else:
                        parts.append("" if value is None else str(value))
                base = f"{prefix}:{_digest(parts)}"
                n = seen.get(base, 0) + 1
                seen[base] = n
                built[int(row[0])] = base if n == 1 else f"{base}~{n}"
            self._keys[table] = built

    def key(self, table: str, row_id: int) -> str:
        found = self._keys.get(table, {}).get(int(row_id))
        if found is None:
            self.dangling += 1
            return f"{SPECS[table][0]}:dangling-{int(row_id)}"
        return found

    def count(self) -> dict[str, int]:
        return {t: len(v) for t, v in self._keys.items()}


def _is_id_field(name: str) -> bool:
    return name == "id" or name.endswith(("_id", "_ids"))


def _as_row_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit() and not value.startswith("0"):
        return int(value)
    return None


class Canon:
    def __init__(self, ids: IdMap | None, overrides: dict[str, str] | None = None) -> None:
        self.ids = ids
        self.overrides = overrides or {}

    def _table_for(self, field: str, parent: str | None) -> str | None:
        """``<parent>.<field>`` override, then (bare ``id``) the parent's table, then the field's
        override or table; a bare ``id`` falls back to the check's ``id`` override."""
        if parent is not None and f"{parent}.{field}" in self.overrides:
            return self.overrides[f"{parent}.{field}"]
        if field == "id":
            return PARENT_TABLES.get(parent or "") or self.overrides.get("id")
        found = self.overrides.get(field) or FIELD_TABLES.get(field)
        if found is None:  # e.g. ``covered_instrument_ids``: the last known id name decides
            for suffix in ("instrument_id", "signal_id", "account_id", "alert_id", "note_id"):
                if field.endswith((f"_{suffix}", f"_{suffix}s")):
                    return FIELD_TABLES[suffix]
        return found

    def _id_value(self, value: Any, field: str, parent: str | None, path: str) -> Any:
        """``value`` of an id-like field: mapped, or raised when it is an unplaceable integer."""
        if isinstance(value, (list, tuple)):
            return [self._id_value(v, field, parent, f"{path}[]") for v in value]
        row_id = _as_row_id(value)
        if row_id is None:
            return self.value(value, path, field, parent)
        table = self._table_for(field, parent)
        if table == "keep":
            return value
        if table is None or self.ids is None:
            raise UnmappedId(path)
        return self.ids.key(table, row_id)

    def value(self, obj: Any, path: str = "$", field: str | None = None, parent: str | None = None):
        from cashu.core.mcp.labels import Labelled  # imported lazily: harness imports cashu first

        if isinstance(obj, str) and not isinstance(obj, enum.Enum):
            for prefix, alias in PATH_ALIASES:
                if prefix in obj:
                    obj = obj.replace(prefix, alias)
            return obj
        if obj is None or isinstance(obj, bool):
            return obj
        if isinstance(obj, Labelled):
            inner = (
                self._id_value(obj.value, field, parent, path)
                if field is not None and _is_id_field(field)
                else self.value(obj.value, path, field, parent)
            )
            return {"$label": str(obj.label.value), "value": inner}
        if isinstance(obj, enum.Enum):
            return self.value(obj.value, path, field, parent)
        if isinstance(obj, int):
            return obj
        if isinstance(obj, float):
            if math.isnan(obj):
                return "NaN"
            if math.isinf(obj):
                return "Infinity" if obj > 0 else "-Infinity"
            return obj
        if isinstance(obj, Decimal):
            return str(obj)
        if isinstance(obj, dt.datetime):
            return obj.isoformat()
        if isinstance(obj, dt.date):
            return obj.isoformat()
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                key = self.value(k, path, None, parent)
                if not isinstance(key, str):
                    key = str(key)
                name = k if isinstance(k, str) else None
                sub = f"{path}.{name}" if name else f"{path}{{}}"
                if name is not None and _is_id_field(name):
                    out[key] = self._id_value(v, name, field, sub)
                else:
                    out[key] = self.value(v, sub, name, field)
            return out
        if isinstance(obj, (list, tuple)):
            return [self.value(v, f"{path}[]", field, parent) for v in obj]
        if isinstance(obj, (set, frozenset)):
            items = [self.value(v, f"{path}[]", field, parent) for v in obj]
            return sorted(items, key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False))
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            return self.value(
                {f.name: getattr(obj, f.name) for f in dataclasses.fields(obj)}, path, field, parent
            )
        if isinstance(obj, bytes):
            return obj.hex()
        table = getattr(type(obj), "__tablename__", None)
        if table in SPECS and self.ids is not None and getattr(obj, "id", None) is not None:
            return self.ids.key(table, obj.id)  # an ORM row -> its natural key, never its contents
        raise TypeError(f"no canonical form for {type(obj).__name__} at {path}")


def dumps(data: Any) -> str:
    return (
        json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        + "\n"
    )


def sha256(text_: str) -> str:
    return hashlib.sha256(text_.encode("utf-8")).hexdigest()
