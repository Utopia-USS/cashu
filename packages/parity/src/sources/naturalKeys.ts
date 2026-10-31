/// <reference types="node" />
/**
 * Natural keys of database rows, exactly as `parity/python/canon.py` (`SPECS`, `IdMap`) builds them:
 * `<prefix>:<first 16 hex of sha256(parts joined by U+001F)>`, references to other tables by that
 * table's natural key, `~2`, `~3` ... for rows with equal parts in id order. The goldens carry these
 * keys instead of integer ids, so a TS producer must emit the same ones. `SPECS` is a verbatim copy
 * of canon.py's (guarded by `naturalKeys.test.ts`).
 */

import { createHash } from "node:crypto";

export interface KeySpec {
  readonly prefix: string;
  /** Selects the id, then the key parts. */
  readonly sql: string;
  /** Referenced table per part (null: the raw value). */
  readonly refs: readonly (string | null)[];
}

export const SPECS: Readonly<Record<string, KeySpec>> = Object.freeze({
  profiles: { prefix: "profile", sql: "SELECT id, slug FROM profiles", refs: [null] },
  accounts: {
    prefix: "account",
    sql: "SELECT id, profile_id, bank, coalesce(external_id, ''), type, currency, CASE WHEN external_id IS NULL THEN name ELSE '' END FROM accounts",
    refs: ["profiles", null, null, null, null, null],
  },
  inv_instruments: {
    prefix: "instrument",
    sql: "SELECT id, coalesce(isin, ''), coalesce(symbol, ''), coalesce(mic, ''), currency, name FROM inv_instruments",
    refs: [null, null, null, null, null],
  },
  inv_signals: {
    prefix: "signal",
    sql: "SELECT id, profile_id, rule_id, dedup_key, first_seen_at FROM inv_signals",
    refs: ["profiles", null, null, null],
  },
  alerts: {
    prefix: "alert",
    sql: "SELECT id, profile_id, created_at, kind, instrument_id FROM alerts",
    refs: ["profiles", null, null, "inv_instruments"],
  },
  inv_theses: {
    prefix: "thesis",
    sql: "SELECT id, profile_id, instrument_id, created_at FROM inv_theses",
    refs: ["profiles", "inv_instruments", null],
  },
  inv_topic_theses: {
    prefix: "topic-thesis",
    sql: "SELECT id, profile_id, segment FROM inv_topic_theses",
    refs: ["profiles", null],
  },
  research_runs: {
    prefix: "research-run",
    sql: "SELECT id, profile_id, started_at FROM research_runs",
    refs: ["profiles", null],
  },
  research_notes: {
    prefix: "note",
    sql: "SELECT id, profile_id, run_id, created_at, title FROM research_notes",
    refs: ["profiles", "research_runs", null, null],
  },
  inv_decisions: {
    prefix: "decision",
    sql: "SELECT id, profile_id, created_at, action, instrument_id FROM inv_decisions",
    refs: ["profiles", null, null, "inv_instruments"],
  },
  inv_transactions: {
    prefix: "inv-txn",
    sql: "SELECT id, account_id, dedup_hash FROM inv_transactions",
    refs: ["accounts", null],
  },
  transactions: {
    prefix: "txn",
    sql: "SELECT id, account_id, dedup_hash, occurrence FROM transactions",
    refs: ["accounts", null, null],
  },
  inv_import_batches: {
    prefix: "inv-import",
    sql: "SELECT id, profile_id, account_id, file_sha256, created_at FROM inv_import_batches",
    refs: ["profiles", "accounts", null, null],
  },
  import_batches: {
    prefix: "import",
    sql: "SELECT id, profile_id, started_at, coalesce(filename, '') FROM import_batches",
    refs: ["profiles", null, null],
  },
  loans: { prefix: "loan", sql: "SELECT id, account_id FROM loans", refs: ["accounts"] },
  depreciations: {
    prefix: "depreciation",
    sql: "SELECT id, account_id FROM depreciations",
    refs: ["accounts"],
  },
  asset_details: {
    prefix: "asset-detail",
    sql: "SELECT id, account_id FROM asset_details",
    refs: ["accounts"],
  },
  inv_strategy_versions: {
    prefix: "strategy-version",
    sql: "SELECT id, profile_id, version FROM inv_strategy_versions",
    refs: ["profiles", null],
  },
  watchlist_items: {
    prefix: "watch",
    sql: "SELECT id, profile_id, instrument_id FROM watchlist_items",
    refs: ["profiles", "inv_instruments"],
  },
  proposals: {
    prefix: "proposal",
    sql: "SELECT id, profile_id, created_at, kind FROM proposals",
    refs: ["profiles", null, null],
  },
  inv_rule_runs: {
    prefix: "rule-run",
    sql: "SELECT id, profile_id, started_at, trigger FROM inv_rule_runs",
    refs: ["profiles", null, null],
  },
  reviews: {
    prefix: "review",
    sql: "SELECT id, profile_id, module, done_at FROM reviews",
    refs: ["profiles", null, null],
  },
  inv_manual_valuations: {
    prefix: "manual-valuation",
    sql: "SELECT id, profile_id, instrument_id, as_of FROM inv_manual_valuations",
    refs: ["profiles", "inv_instruments", null],
  },
  category_rules: {
    prefix: "category-rule",
    sql: "SELECT id, profile_id, merchant_key FROM category_rules",
    refs: ["profiles", null],
  },
  balances: {
    prefix: "balance",
    sql: "SELECT id, account_id, date, source FROM balances",
    refs: ["accounts", null, null],
  },
  inv_planned_deposits: {
    prefix: "planned-deposit",
    sql: "SELECT id, profile_id, created_at, planned_date FROM inv_planned_deposits",
    refs: ["profiles", null, null],
  },
  inv_position_snapshots: {
    prefix: "position-snapshot",
    sql: "SELECT id, account_id, instrument_id, as_of FROM inv_position_snapshots",
    refs: ["accounts", "inv_instruments", null],
  },
  connectors: { prefix: "connector", sql: "SELECT id, name FROM connectors", refs: [null] },
  inv_profile_instruments: {
    prefix: "profile-instrument",
    sql: "SELECT id, profile_id, instrument_id FROM inv_profile_instruments",
    refs: ["profiles", "inv_instruments"],
  },
  inv_instrument_renames: {
    prefix: "instrument-rename",
    sql: "SELECT id, profile_id, date, old_instrument_id, new_instrument_id FROM inv_instrument_renames",
    refs: ["profiles", null, "inv_instruments", "inv_instruments"],
  },
  inv_account_settings: {
    prefix: "account-settings",
    sql: "SELECT account_id AS id, account_id FROM inv_account_settings",
    refs: ["accounts"],
  },
  inv_instrument_aliases: {
    prefix: "instrument-alias",
    sql: "SELECT id, instrument_id, namespace, value FROM inv_instrument_aliases",
    refs: ["inv_instruments", null, null],
  },
  connector_bindings: {
    prefix: "connector-binding",
    sql: "SELECT id, account_id, connector_id FROM connector_bindings",
    refs: ["accounts", null],
  },
});

/** A raw SQLite value as `node:sqlite` returns it with `readBigInts`. */
export type SqlValue = null | bigint | number | string | Uint8Array;

/** The read side of a database: positional rows of a query. */
export interface SqlRows {
  rows(sql: string, ...params: (string | number | bigint | null)[]): SqlValue[][];
}

/** canon.py `_digest`: first 16 hex of sha256 over the parts joined by U+001F. */
export function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex").slice(0, 16);
}

/** Python `str(value)` for the value types the key parts hold (text, integers). */
function partText(value: SqlValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("natural key part of an unsupported SQLite type (REAL or BLOB)");
}

function rowId(value: SqlValue | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error("row id is not an integer");
}

/**
 * canon.py `IdMap`, built lazily per table (a table's keys are computed on first use, with the
 * tables it references). `dangling` counts references to rows that do not exist.
 */
export class NaturalKeys {
  private readonly db: SqlRows;
  private readonly built = new Map<string, Map<bigint, string>>();
  dangling = 0;

  constructor(db: SqlRows) {
    this.db = db;
  }

  /** The natural key of row `id` of `table` (`<prefix>:dangling-<id>` when there is no such row). */
  key(table: string, id: number | bigint): string {
    const spec = SPECS[table];
    if (spec === undefined) throw new Error(`no natural key spec for table '${table}'`);
    const found = this.table(table).get(BigInt(id));
    if (found === undefined) {
      this.dangling += 1;
      return `${spec.prefix}:dangling-${BigInt(id)}`;
    }
    return found;
  }

  /** Row count per table built so far. */
  count(): Record<string, number> {
    return Object.fromEntries([...this.built].map(([t, m]) => [t, m.size]));
  }

  private table(table: string): Map<bigint, string> {
    const cached = this.built.get(table);
    if (cached !== undefined) return cached;
    const spec = SPECS[table] as KeySpec;
    const rows = this.db
      .rows(spec.sql)
      .map((r) => ({ id: rowId(r[0]), parts: r.slice(1) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out = new Map<bigint, string>();
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (row.parts.length !== spec.refs.length) throw new Error(`spec '${table}' arity mismatch`);
      const parts = row.parts.map((value, i) => {
        const ref = spec.refs[i] ?? null;
        return ref !== null && value !== null ? this.key(ref, rowId(value)) : partText(value);
      });
      const base = `${spec.prefix}:${digest(parts)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.set(row.id, n === 1 ? base : `${base}~${n}`);
    }
    this.built.set(table, out);
    return out;
  }
}
