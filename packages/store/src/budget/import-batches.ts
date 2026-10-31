// Import audit rows (events.md 8.3, S24 2): APPEND, one row per `importBatch.recorded` gid (ULID;
// CREATE-once). `account_id` references the resolved account. The archive blob reference is kept
// in two view columns Python has no counterpart for (D-24.8).
import { ACCOUNTS } from "../core/accounts.js";
import type { FoldEvent, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { viewTimestamp } from "../sql/values.js";

const table: TableDef = {
  name: "import_batches",
  columns: [
    { name: "source", type: "TEXT", notNull: true },
    { name: "bank", type: "TEXT" },
    { name: "account_id", type: "INTEGER", ref: "accounts" },
    { name: "filename", type: "TEXT" },
    { name: "started_at", type: "TEXT", notNull: true },
    { name: "finished_at", type: "TEXT" },
    { name: "num_seen", type: "INTEGER", notNull: true },
    { name: "num_inserted", type: "INTEGER", notNull: true },
    { name: "num_duplicates", type: "INTEGER", notNull: true },
    { name: "notes", type: "TEXT" },
    { name: "archive_sha256", type: "TEXT" },
    { name: "archive_ext", type: "TEXT" },
  ],
  indexes: [{ columns: ["account_id"] }],
};

/** A nullable domain timestamp column: the stamp when present, else the payload's field. */
function stamped(e: FoldEvent, column: string, explicit: unknown): string | null {
  const stamps = e.data.stamps as Record<string, string | null> | undefined;
  if (stamps !== undefined && column in stamps) return viewTimestamp(stamps[column] ?? null);
  return viewTimestamp(typeof explicit === "string" ? explicit : null);
}

export const importBatchesMaterializer: Materializer = {
  id: "budget.import_batches",
  version: 1,
  tables: [table],
  handles: ["importBatch.recorded"],
  identity: [ACCOUNTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(table.name, "DELETE FROM import_batches WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    const archive = d.archive as { sha256: string; ext: string } | undefined;
    ctx.sql.write(
      table.name,
      `INSERT OR IGNORE INTO import_batches (id, gid, source, bank, account_id, filename, started_at,
         finished_at, num_seen, num_inserted, num_duplicates, notes, archive_sha256, archive_ext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      String(d.source),
      (d.bank as string | null) ?? null,
      typeof d.account === "string" ? ctx.id(ctx.resolve(ACCOUNTS, d.account)) : null,
      (d.filename as string | null) ?? null,
      ctx.time(e, "started_at", String(d.startedAt)),
      stamped(e, "finished_at", d.finishedAt),
      Number(d.numSeen),
      Number(d.numInserted),
      Number(d.numDuplicates),
      (d.notes as string | null) ?? null,
      archive?.sha256 ?? null,
      archive?.ext ?? null,
    );
  },
};
