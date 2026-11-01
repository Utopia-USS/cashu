// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Per-transaction merge (S31a spec 4.2, S25 rule 1): within one Python transaction the rows of one
// `(table, localId)` become one logical row, kept at the position of its first row, so a service
// that flushes one change in two steps (research refresh + rule id, close + payload) ships one event:
//
//   insert, update*          -> insert; post = last post; fields = the last post's synced columns
//   update, update+          -> update; fields = union (later wins); prev[c] = earliest prev of c;
//                               post = last post; a column back at its earliest prev is no change
//   update*, delete          -> delete; fields = the delete's last state
//   insert, ..., delete      -> nothing
//   explicit op              -> a barrier: never merged, keeps its position
//
// A row after a delete of the same key (a reused rowid) starts a new logical row.
import { canonicalJson } from "../canonical.js";
import { EXPLICIT_OPS, type OutboxOp, type OutboxRow } from "./outbox.js";

/** One logical row of a transaction after the merge. */
export interface LogicalRow {
  readonly table: string;
  readonly op: OutboxOp;
  readonly localId: string;
  readonly profileId: number | null;
  readonly gid: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly prev: Readonly<Record<string, unknown>> | null;
  readonly key: Readonly<Record<string, unknown>> | null;
  readonly post: Readonly<Record<string, unknown>> | null;
  /** The last merged row's outbox `ts` (the event `at`). */
  readonly ts: string;
  readonly txn: string;
  /** Outbox ids merged into this row. */
  readonly ids: readonly number[];
}

interface Acc {
  table: string;
  op: OutboxOp;
  localId: string;
  profileId: number | null;
  gid: string | null;
  fields: Record<string, unknown>;
  prev: Record<string, unknown> | null;
  key: Readonly<Record<string, unknown>> | null;
  post: Readonly<Record<string, unknown>> | null;
  ts: string;
  txn: string;
  ids: number[];
  /** Columns of the insert (Python inserts record every synced column). */
  insertColumns: readonly string[] | null;
  dropped: boolean;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function start(r: OutboxRow): Acc {
  return {
    table: r.table,
    op: r.op,
    localId: r.localId,
    profileId: r.profileId,
    gid: r.gid,
    fields: { ...r.fields },
    prev: r.prev === null ? null : { ...r.prev },
    key: r.key,
    post: r.post,
    ts: r.ts,
    txn: r.txn,
    ids: [r.id],
    insertColumns: r.op === "insert" ? Object.keys(r.fields) : null,
    dropped: false,
  };
}

/** Folds `r` (same key, later) into `acc`. */
function fold(acc: Acc, r: OutboxRow): void {
  acc.ids.push(r.id);
  acc.ts = r.ts;
  acc.gid = r.gid ?? acc.gid;
  acc.key = r.key ?? acc.key;
  if (r.op === "delete") {
    if (acc.op === "insert") {
      acc.dropped = true;
      return;
    }
    acc.op = "delete";
    acc.fields = { ...r.fields };
    acc.post = null;
    return;
  }
  // r is an update (inserts after a delete start a new row; explicit ops never reach here).
  acc.post = r.post ?? acc.post;
  if (acc.op === "insert") {
    const cols = acc.insertColumns ?? Object.keys(acc.fields);
    const next: Record<string, unknown> = { ...acc.fields, ...r.fields };
    const post = acc.post;
    acc.fields = Object.fromEntries(
      cols.map((c) => [c, post !== null && c in post ? post[c] : next[c]]),
    );
    return;
  }
  for (const [c, v] of Object.entries(r.fields)) {
    if (!(c in acc.fields) && r.prev !== null && c in r.prev) {
      acc.prev = { ...(acc.prev ?? {}), [c]: r.prev[c] };
    }
    acc.fields[c] = v;
  }
}

/** Drops columns of a merged update whose new value equals the earliest previous one. */
function settle(acc: Acc): void {
  if (acc.op !== "update" || acc.ids.length < 2 || acc.prev === null) return;
  for (const c of Object.keys(acc.fields)) {
    if (c in acc.prev && same(acc.fields[c], acc.prev[c])) {
      delete acc.fields[c];
      delete acc.prev[c];
    }
  }
}

const done = (a: Acc): LogicalRow => ({
  table: a.table,
  op: a.op,
  localId: a.localId,
  profileId: a.profileId,
  gid: a.gid,
  fields: a.fields,
  prev: a.prev,
  key: a.key,
  post: a.post,
  ts: a.ts,
  txn: a.txn,
  ids: a.ids,
});

/** The logical rows of one transaction's outbox rows (id order), in first-row order. */
export function mergeTxn(rows: readonly OutboxRow[]): readonly LogicalRow[] {
  const order: Acc[] = [];
  const open = new Map<string, Acc>();
  for (const r of rows) {
    if (EXPLICIT_OPS.includes(r.op)) {
      order.push(start(r));
      continue;
    }
    const k = `${r.table}\u001f${r.localId}`;
    const acc = open.get(k);
    if (acc === undefined || acc.dropped || acc.op === "delete" || r.op === "insert") {
      const fresh = start(r);
      order.push(fresh);
      open.set(k, fresh);
      continue;
    }
    fold(acc, r);
  }
  const out: LogicalRow[] = [];
  for (const acc of order) {
    if (acc.dropped) continue;
    settle(acc);
    // An update whose every change was undone inside the transaction changes nothing.
    if (acc.op === "update" && Object.keys(acc.fields).length === 0) continue;
    out.push(done(acc));
  }
  return out;
}
