// Research runs and notes (events.md 8.9; S25 spec 4.14, 4.15).
//
// Runs: `researchRun.started` APPEND (status running), `researchRun.finished` FWW (first-writer-wins
// on the run's status): the first applied finish in fold order `(hlc, eid)` sets status, counts and
// finished_at; every later finish (a second device closing the same stale run, a late `done` from the
// run's own device after a `failed {interrupted}` close) is a no-op. A run that never finishes stays
// running in the view (D-G9); any device closes a stale run `failed {interrupted}` on its next start /
// note, the leader in its housekeeping (S21b, lead decision 2026-11-01).
//
// Notes: `note.added` APPEND; LWW-F side fields:
// - `read_at`: on add the `read_at` stamp when present (null included), else the domain time for an
//   owner note (born read), else null; `note.read` fills it only while null (first applied read wins,
//   D-S7: Python marks unread rows only);
// - `note.dismissed`: GUARD no-op while dismissed; `dismissed_at`, `cooldown_until`, `updated_at`;
// - `note.restored`: GUARD only while dismissed; clears both, `updated_at` (restore windows are
//   checked at emit time, events.md 6.3);
// - `note.candidateUpdated` (S25-F4): replaces `instrument_id` and `details`, `updated_at`;
// - `note.signalLinked` (S25-F5): `signal_id` = the signal gid as named (readers map an alias to its
//   episode through `inv_signal_aliases`, D-S2); no `updated_at` change.
import type { Materializer } from "../engine/types.js";
import { restoreFloats } from "../events/v1/primitives.js";
import type { TableDef } from "../sql/ddl.js";
import { hasStamp, instrumentId, json, nullableTime, refId, str } from "./fold-values.js";
import { INSTRUMENTS } from "./instruments.js";

const runs: TableDef = {
  name: "research_runs",
  columns: [
    { name: "started_at", type: "TEXT", notNull: true },
    { name: "finished_at", type: "TEXT" },
    { name: "status", type: "TEXT", notNull: true, default: "'running'" },
    { name: "scope", type: "TEXT", notNull: true, json: true },
    { name: "counts", type: "TEXT", notNull: true, json: true },
    { name: "created_by", type: "TEXT", notNull: true, default: "'agent'" },
  ],
};

export const researchRunsMaterializer: Materializer = {
  id: "investments.research_runs",
  version: 1,
  tables: [runs],
  handles: ["researchRun.started", "researchRun.finished"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(runs.name, "DELETE FROM research_runs WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    const g = e.gid;
    ctx.members.add(g, g);
    if (e.type === "researchRun.started") {
      ctx.sql.write(
        runs.name,
        `INSERT OR IGNORE INTO research_runs (id, gid, started_at, finished_at, status, scope, counts, created_by)
         VALUES (?, ?, ?, NULL, 'running', ?, '{}', ?)`,
        ctx.id(g),
        g,
        ctx.time(e, "started_at"),
        json(d.scope ?? {}),
        String(d.createdBy ?? "agent"),
      );
      return;
    }
    // FWW: only a running run takes a finish (the first applied finish in fold order wins).
    ctx.sql.write(
      runs.name,
      "UPDATE research_runs SET status = ?, counts = ?, finished_at = ? WHERE gid = ? AND status = 'running'",
      String(d.status),
      json(d.counts ?? {}),
      ctx.time(e, "finished_at"),
      g,
    );
  },
};

const notes: TableDef = {
  name: "research_notes",
  columns: [
    { name: "run_id", type: "INTEGER", ref: "research_runs" },
    { name: "instrument_id", type: "INTEGER", ref: "inv_instruments" },
    { name: "theme", type: "TEXT" },
    { name: "kind", type: "TEXT", notNull: true },
    { name: "polarity", type: "TEXT", notNull: true, default: "'neutral'" },
    { name: "strength", type: "INTEGER", notNull: true, default: "1" },
    { name: "thesis_relation", type: "TEXT", notNull: true, default: "'none'" },
    { name: "thesis_field", type: "TEXT" },
    { name: "title", type: "TEXT", notNull: true },
    { name: "summary", type: "TEXT", notNull: true },
    { name: "sources", type: "TEXT", notNull: true, json: true },
    { name: "details", type: "TEXT", json: true },
    { name: "candidate_key", type: "TEXT" },
    { name: "signal_id", type: "INTEGER", ref: "inv_signals" },
    { name: "observed_at", type: "TEXT", notNull: true },
    { name: "expires_at", type: "TEXT", notNull: true },
    { name: "created_by", type: "TEXT", notNull: true, default: "'agent'" },
    { name: "dismissed_at", type: "TEXT" },
    { name: "cooldown_until", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "read_at", type: "TEXT" },
    { name: "segment", type: "TEXT" },
  ],
  indexes: [
    { columns: ["instrument_id", "read_at"] },
    { columns: ["run_id"] },
    { columns: ["candidate_key"] },
    { columns: ["signal_id"] },
  ],
};

export const researchNotesMaterializer: Materializer = {
  id: "investments.research_notes",
  version: 1,
  tables: [notes],
  handles: [
    "note.added",
    "note.read",
    "note.dismissed",
    "note.restored",
    "note.candidateUpdated",
    "note.signalLinked",
  ],
  identity: [INSTRUMENTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(notes.name, "DELETE FROM research_notes WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    const g = e.gid;
    ctx.members.add(g, g);
    if (e.type === "note.added") {
      const readAt = hasStamp(e, "read_at")
        ? nullableTime(e, "read_at", null)
        : d.createdBy === "user"
          ? ctx.time(e, "read_at")
          : null;
      ctx.sql.write(
        notes.name,
        `INSERT OR IGNORE INTO research_notes (id, gid, run_id, instrument_id, theme, kind, polarity, strength,
           thesis_relation, thesis_field, title, summary, sources, details, candidate_key, signal_id,
           observed_at, expires_at, created_by, dismissed_at, cooldown_until, created_at, updated_at,
           read_at, segment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.id(g),
        g,
        refId(ctx, d.run),
        instrumentId(ctx, d.instrument),
        str(d.theme),
        String(d.kind),
        String(d.polarity ?? "neutral"),
        typeof d.strength === "number" ? d.strength : 1,
        String(d.thesisRelation ?? "none"),
        str(d.thesisField),
        String(d.title),
        String(d.summary),
        json(d.sources ?? []),
        json(restoreFloats(d.details, d.detailsFloats)), // events.md 4.3
        str(d.candidateKey),
        refId(ctx, d.signal),
        ctx.time(e, "observed_at", str(d.observedAt)),
        ctx.time(e, "expires_at", str(d.expiresAt)),
        String(d.createdBy ?? "agent"),
        nullableTime(e, "dismissed_at", null),
        nullableTime(e, "cooldown_until", null),
        ctx.time(e, "created_at"),
        ctx.time(e, "updated_at"),
        readAt,
        str(d.segment),
      );
      return;
    }
    const row = ctx.sql.get<{ dismissed_at: string | null }>(
      "SELECT dismissed_at FROM research_notes WHERE gid = ?",
      g,
    );
    if (row === undefined) return; // parked: its add is not held
    switch (e.type) {
      case "note.read":
        ctx.sql.write(
          notes.name,
          "UPDATE research_notes SET read_at = ? WHERE gid = ? AND read_at IS NULL",
          ctx.time(e, "read_at"),
          g,
        );
        return;
      case "note.dismissed":
        if (row.dismissed_at !== null) return;
        ctx.sql.write(
          notes.name,
          "UPDATE research_notes SET dismissed_at = ?, cooldown_until = ?, updated_at = ? WHERE gid = ?",
          ctx.time(e, "dismissed_at"),
          nullableTime(e, "cooldown_until", d.cooldownUntil),
          ctx.time(e, "updated_at"),
          g,
        );
        return;
      case "note.restored":
        if (row.dismissed_at === null) return;
        ctx.sql.write(
          notes.name,
          "UPDATE research_notes SET dismissed_at = NULL, cooldown_until = NULL, updated_at = ? WHERE gid = ?",
          ctx.time(e, "updated_at"),
          g,
        );
        return;
      case "note.candidateUpdated":
        ctx.sql.write(
          notes.name,
          "UPDATE research_notes SET instrument_id = ?, details = ?, updated_at = ? WHERE gid = ?",
          instrumentId(ctx, d.instrument),
          json(restoreFloats(d.details, d.detailsFloats)),
          ctx.time(e, "updated_at"),
          g,
        );
        return;
      case "note.signalLinked":
        ctx.sql.write(
          notes.name,
          "UPDATE research_notes SET signal_id = ? WHERE gid = ?",
          refId(ctx, d.signal),
          g,
        );
        return;
    }
  },
};
