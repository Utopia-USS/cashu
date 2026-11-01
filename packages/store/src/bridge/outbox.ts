// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The Python outbox row model at the bridge boundary (S31a spec 4.1; S30 `sync_outbox`): rows are
// validated with zod once, as Python stores them (`fields` / `prev` / `key` / `post` already parsed
// from their JSON text by the reader). `pending()` returns local rows only: an `inbound` row here is a
// contract violation. Rows of one `txn` are contiguous in id order; `completeTxns` keeps the
// transactions a page holds whole (the reader reads on until the last one ends).
import { z } from "zod";

const OUTBOX_OPS = ["insert", "update", "delete", "merge", "undo", "leg_delete"] as const;
export type OutboxOp = (typeof OUTBOX_OPS)[number];
/** The explicit ops of Python `sync_outbox.EXPLICIT_OPS`: barriers, never merged. */
export const EXPLICIT_OPS: readonly OutboxOp[] = ["merge", "undo", "leg_delete"];

const jsonRecord = z.record(z.string(), z.unknown());
/** Python `utcnow()` as SQLite stores it: `YYYY-MM-DD HH:MM:SS[.ffffff]`, naive UTC. */
const pyTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/);

export const outboxRowSchema = z.strictObject({
  id: z.int().positive(),
  ts: pyTimestamp,
  txn: z.string().min(1),
  profileId: z.int().positive().nullable(),
  table: z.string().min(1),
  op: z.enum(OUTBOX_OPS),
  localId: z.string().min(1),
  gid: z.string().min(1).nullable(),
  fields: jsonRecord,
  prev: jsonRecord.nullable(),
  key: jsonRecord.nullable(),
  post: jsonRecord.nullable(),
  origin: z.literal("local"),
});

export type OutboxRow = z.infer<typeof outboxRowSchema>;

/** The outbox `ts` as an event `at` (ISO, `Z`, the stored fraction kept). */
export function atOf(ts: string): string {
  return `${ts.replace(" ", "T")}Z`;
}

/**
 * The rows of the complete transactions of an id-ordered page: `more` = the page was cut at its
 * limit, so its last transaction may continue on the next page and is left out (the reader reads
 * on until a transaction ends; a page of one huge transaction is the reader's to extend).
 */
export function completeTxns(rows: readonly OutboxRow[], more: boolean): readonly OutboxRow[] {
  if (!more || rows.length === 0) return rows;
  const lastTxn = rows.at(-1)?.txn;
  let end = rows.length;
  while (end > 0 && rows[end - 1]?.txn === lastTxn) end--;
  return rows.slice(0, end);
}

/** Groups id-ordered rows by transaction, in order (rows of one txn are contiguous). */
export function byTxn(rows: readonly OutboxRow[]): readonly (readonly OutboxRow[])[] {
  const out: OutboxRow[][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last !== undefined && last[0]?.txn === r.txn) last.push(r);
    else out.push([r]);
  }
  return out;
}
