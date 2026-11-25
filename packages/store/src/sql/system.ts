// Store-owned tables (not module views): the decrypted log copy, fold indexes, identity, cursors.
import type { TableDef } from "./ddl.js";

/** Bump with a migration when a system table changes shape (the log is NOT rebuildable). */
export const SYSTEM_SCHEMA_VERSION = 2;

export const SYSTEM_TABLES: readonly TableDef[] = [
  {
    name: "store_meta",
    primaryKey: ["key"],
    columns: [
      { name: "key", type: "TEXT", notNull: true },
      { name: "value", type: "TEXT", notNull: true },
    ],
    internal: true,
  },
  {
    // Every held event of the vault. `state`: applied (folded) | suppressed (causal suppression or an
    // FWW loser, events.md 6.6) | parked (unknown type, newer version, invalid payload: events.md 7).
    // The original body is `columns + extra + (raw_data ?? data)`, the device being the HLC's suffix;
    // `data` is the payload upcast to the reader's current version and validated (NULL while parked),
    // in the compact encoding of engine/compact.ts.
    name: "event_log",
    primaryKey: ["seq"],
    columns: [
      { name: "seq", type: "INTEGER", notNull: true },
      { name: "eid", type: "TEXT", notNull: true },
      { name: "hlc", type: "TEXT", notNull: true },
      { name: "at", type: "TEXT", notNull: true },
      { name: "type", type: "TEXT", notNull: true },
      { name: "v", type: "INTEGER", notNull: true },
      { name: "gid", type: "TEXT", notNull: true },
      { name: "cause", type: "TEXT" },
      { name: "origin", type: "TEXT" },
      { name: "extra", type: "TEXT" },
      { name: "state", type: "TEXT", notNull: true },
      { name: "reason", type: "TEXT" },
      { name: "raw_data", type: "TEXT" },
      { name: "data", type: "TEXT" },
    ],
    indexes: [
      { columns: ["eid"], unique: true },
      { columns: ["type", "hlc", "eid"] },
      { columns: ["gid"] },
      { columns: ["cause"], where: "cause IS NOT NULL" },
    ],
    internal: true,
  },
  {
    // Subjects an event belongs to beyond its gid (Materializer.refs), for partition re-folds.
    name: "event_refs",
    primaryKey: ["subject", "eid"],
    withoutRowid: true,
    columns: [
      { name: "subject", type: "TEXT", notNull: true },
      { name: "eid", type: "TEXT", notNull: true },
    ],
    internal: true,
  },
  {
    // Not a valid envelope at all (corrupt or foreign data): kept for diagnostics, never folded.
    name: "event_rejects",
    primaryKey: ["seq"],
    columns: [
      { name: "seq", type: "INTEGER", notNull: true },
      { name: "device", type: "TEXT" },
      { name: "error", type: "TEXT", notNull: true },
      { name: "raw", type: "TEXT", notNull: true },
    ],
    internal: true,
  },
  {
    // events.md 7.1: parked events counted per type (the app shows "update cashU" when non-empty).
    name: "unknown_events",
    primaryKey: ["type", "v", "reason"],
    withoutRowid: true,
    columns: [
      { name: "type", type: "TEXT", notNull: true },
      { name: "v", type: "INTEGER", notNull: true },
      { name: "reason", type: "TEXT", notNull: true },
      { name: "count", type: "INTEGER", notNull: true },
    ],
  },
  {
    name: "view_ids",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "INTEGER", notNull: true },
      { name: "gid", type: "TEXT", notNull: true },
    ],
    indexes: [{ columns: ["gid"], unique: true }],
    internal: true,
  },
  {
    // Highest `(hlc, eid)` folded per materializer: the incremental fast path's precondition.
    name: "materializer_state",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "TEXT", notNull: true },
      { name: "hwm", type: "TEXT", notNull: true },
    ],
    internal: true,
  },
  {
    name: "identity_roots",
    primaryKey: ["kind", "gid"],
    withoutRowid: true,
    columns: [
      { name: "kind", type: "TEXT", notNull: true },
      { name: "gid", type: "TEXT", notNull: true },
      { name: "root", type: "TEXT", notNull: true },
    ],
    indexes: [{ columns: ["kind", "root"] }],
    internal: true,
  },
  {
    name: "identity_accepted",
    primaryKey: ["kind", "eid"],
    withoutRowid: true,
    columns: [
      { name: "kind", type: "TEXT", notNull: true },
      { name: "eid", type: "TEXT", notNull: true },
      { name: "value", type: "TEXT", notNull: true },
    ],
    internal: true,
  },
  {
    // Carrier position per writing device (S28a EventSink.cursors), persisted with each batch.
    name: "sync_cursors",
    primaryKey: ["device"],
    columns: [
      { name: "device", type: "TEXT", notNull: true },
      { name: "seg", type: "INTEGER", notNull: true },
      { name: "offset", type: "INTEGER", notNull: true },
    ],
    internal: true,
  },
];
