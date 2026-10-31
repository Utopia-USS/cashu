// Investments import batches (events.md 8.5; S25 spec 4.3): `invImport.recorded` is APPEND (one row
// per ULID, the first applied event of a gid stands). `archive_path` is the content-addressed blob key
// `<sha256>.<ext>` when the batch archived its file (D-S6; Python's `imports/<slug>/` prefix is a
// device path, the parity projection compares the basename).
import { ACCOUNTS } from "../core/accounts.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { accountId, json } from "./fold-values.js";

const table: TableDef = {
  name: "inv_import_batches",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "importer", type: "TEXT", notNull: true },
    { name: "broker", type: "TEXT", notNull: true },
    { name: "file_name", type: "TEXT", notNull: true },
    { name: "file_sha256", type: "TEXT", notNull: true },
    { name: "archive_path", type: "TEXT" },
    { name: "txn_count", type: "INTEGER", notNull: true },
    { name: "duplicate_count", type: "INTEGER", notNull: true },
    { name: "position_count", type: "INTEGER", notNull: true },
    { name: "rename_count", type: "INTEGER", notNull: true },
    { name: "status_change_count", type: "INTEGER", notNull: true },
    { name: "instrument_count", type: "INTEGER", notNull: true },
    { name: "correction_count", type: "INTEGER", notNull: true },
    { name: "warnings", type: "TEXT", notNull: true, json: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id"] }, { columns: ["file_sha256"] }],
};

const count = (v: unknown): number => (typeof v === "number" ? v : 0);

export const importBatchesMaterializer: Materializer = {
  id: "investments.import_batches",
  version: 1,
  tables: [table],
  handles: ["invImport.recorded"],
  identity: [ACCOUNTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids)
      ctx.sql.write(table.name, "DELETE FROM inv_import_batches WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    ctx.members.add(e.gid, e.gid);
    const archive = d.archive as { sha256?: unknown; ext?: unknown } | undefined;
    ctx.sql.insert(
      table.name,
      `INSERT OR IGNORE INTO inv_import_batches (id, gid, account_id, importer, broker, file_name,
         file_sha256, archive_path, txn_count, duplicate_count, position_count, rename_count,
         status_change_count, instrument_count, correction_count, warnings, created_at)`,
      "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.id(e.gid),
      e.gid,
      accountId(ctx, d.account),
      String(d.importer),
      String(d.broker),
      String(d.fileName),
      String(d.fileSha256),
      archive ? `${String(archive.sha256)}.${String(archive.ext)}` : null,
      count(d.txnCount),
      count(d.duplicateCount),
      count(d.positionCount),
      count(d.renameCount),
      count(d.statusChangeCount),
      count(d.instrumentCount),
      count(d.correctionCount),
      json(d.warnings ?? []),
      ctx.time(e, "created_at"),
    );
  },
};
