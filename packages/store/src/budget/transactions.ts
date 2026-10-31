// Bank transactions and cash expenses (events.md 8.3, gid.md 4.4, S24 2 / 4).
//
// - `txn.imported` creates the row on its row key (resolve(account), dedupHash, occurrence), so a CSV
//   row and the same Open Banking row collapse once their accounts resolve together; the row gid is
//   the anchor (first applied member, N1).
// - `txn.cashExpenseAdded` (ULID) creates a cash pool row (CREATE); `txn.deleted` is its TOMB: the row
//   and its claims go, later events for the gid are no-ops; a delete of any other gid is a no-op.
// - Category claims are per-row registers with a GUARD (an `llm_*` claim never replaces a
//   `manual_txn` one); a claim may address the cash leg of any member
//   (`DET(transactions)["cashleg", member]`), and a cash expense by its gid.
//
// This materializer writes the rows, the claim registers and `fold_txn_keys`; the derived parts
// (cash mirror legs, the effective `category` / `category_source`, transfer groups) are written by
// the budget derivers (`derive/`), never here.
import { Decimal, format2 } from "@cashu/domain";
import { merchantKey } from "@cashu/domain/budget";
import { ACCOUNTS } from "../core/accounts.js";
import { type FoldContext, type FoldEvent, type Materializer, ord } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlJson } from "../sql/values.js";

export const TRANSACTIONS = "transactions";

const table: TableDef = {
  name: TRANSACTIONS,
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "booking_date", type: "TEXT", notNull: true },
    { name: "value_date", type: "TEXT" },
    { name: "amount", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "counterparty_name", type: "TEXT" },
    { name: "counterparty_iban", type: "TEXT" },
    { name: "description", type: "TEXT" },
    { name: "reference", type: "TEXT" },
    { name: "bank_transaction_id", type: "TEXT" },
    { name: "source", type: "TEXT", notNull: true },
    { name: "dedup_hash", type: "TEXT", notNull: true },
    { name: "occurrence", type: "INTEGER", notNull: true, default: "0" },
    { name: "transfer_group_id", type: "TEXT" },
    { name: "is_internal_transfer", type: "INTEGER", notNull: true, default: "0" },
    { name: "category", type: "TEXT" },
    { name: "category_source", type: "TEXT" },
    { name: "raw", type: "TEXT", notNull: true, json: true },
    { name: "import_batch_id", type: "INTEGER", ref: "import_batches" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [
    { columns: ["account_id", "dedup_hash", "occurrence"], unique: true },
    { columns: ["booking_date"] },
    { columns: ["counterparty_iban"] },
    { columns: ["category"] },
    { columns: ["transfer_group_id"], where: "transfer_group_id IS NOT NULL" },
  ],
};

/** Claim registers per row key (created lazily: most transactions never get a claim). */
const claims: TableDef = {
  name: "fold_transaction_claims",
  primaryKey: ["partition"],
  internal: true,
  columns: [
    { name: "partition", type: "TEXT", notNull: true },
    { name: "claim", type: "TEXT" },
    { name: "claim_by", type: "TEXT" },
    { name: "leg_claim", type: "TEXT" },
    { name: "leg_claim_by", type: "TEXT" },
    /** Domain time of the claim that made the cash leg present (the leg row's `created_at`). */
    { name: "leg_on", type: "TEXT" },
  ],
};

/**
 * Per-row keys the derivers group by (written at insert, CREATE with the row): `anchor_ord` = fold
 * order of the anchor (Python's id order stand-in, D-24.2), `amount_key` = `format2(abs(amount))`
 * (S08 grouping), `merchant_key` = Python `merchant_key(counterparty_name, reference, description)`.
 */
const keys: TableDef = {
  name: "fold_txn_keys",
  primaryKey: ["row"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "row", type: "TEXT", notNull: true },
    { name: "anchor_ord", type: "TEXT", notNull: true },
    { name: "amount_key", type: "TEXT", notNull: true },
    { name: "merchant_key", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["amount_key"] }, { columns: ["merchant_key"] }],
};

/** Cash expenses ended by `txn.deleted` (TOMB): later events for the gid are no-ops. */
const tombs: TableDef = {
  name: "fold_txn_tombs",
  primaryKey: ["partition"],
  internal: true,
  withoutRowid: true,
  columns: [{ name: "partition", type: "TEXT", notNull: true }],
};

interface Claims {
  claim: string | null;
  claim_by: string | null;
  leg_claim: string | null;
  leg_claim_by: string | null;
  leg_on: string | null;
}

interface Target {
  readonly key: string;
  readonly isLeg: boolean;
}

const IMPORTED = "txn.imported";
const CASH_EXPENSE = "txn.cashExpenseAdded";
const DELETED = "txn.deleted";
/** Partition (and `dedup_hash`) prefix of a cash expense row: `cashexp:<gid>`. */
export const CASHEXP = "cashexp:";
/** `dedup_hash` prefix of a derived cash leg row: `cashleg:<anchor gid>` (gid.md 4.4). */
export const CASHLEG = "cashleg:";

/** Whether a claim register makes the cash mirror leg present (D-24.3: the manual claim only). */
export function legClaimed(c: { claim: string | null; claim_by: string | null }): boolean {
  return c.claim === "cash_withdrawal" && c.claim_by === "manual_txn";
}

function rowKey(e: FoldEvent, ctx: FoldContext): string {
  return `${ctx.resolve(ACCOUNTS, String(e.data.account))}|${String(e.data.dedupHash)}|${String(e.data.occurrence)}`;
}

/**
 * The row key of a member gid at `e`'s position in the fold: through its own import (events.md 7.10:
 * one row key per gid), which must sort before `e` (until then an event addressed to it is a no-op).
 */
function rowOf(gid: string, e: FoldEvent, ctx: FoldContext): string | undefined {
  const keyed = ctx.keyedEvent(gid, IMPORTED);
  return keyed === undefined || ord(keyed) > ord(e) ? undefined : rowKey(keyed, ctx);
}

/** The partition of a cash expense gid whose add sorts before `e`. */
function expenseOf(gid: string, e: FoldEvent, ctx: FoldContext): string | undefined {
  const added = ctx.keyedEvent(gid, CASH_EXPENSE);
  return added === undefined || ord(added) > ord(e) ? undefined : CASHEXP + gid;
}

/**
 * Rows a claim addresses: the row of a member gid, a cash expense, or (for a leg gid) the row of the
 * member whose import refers to that leg gid. Leg gids are never computed backwards: each import
 * records its leg gid as a ref once, when it enters the log.
 */
function targets(e: FoldEvent, ctx: FoldContext): Target[] {
  const direct = rowOf(e.gid, e, ctx) ?? expenseOf(e.gid, e, ctx);
  if (direct !== undefined) return [{ key: direct, isLeg: false }];
  const found = new Set<string>();
  for (const g of ctx.referrers(e.gid)) {
    const key = rowOf(g, e, ctx);
    if (key !== undefined) found.add(key);
  }
  return [...found].map((key) => ({ key, isLeg: true }));
}

/** An import row key `root|hash|occurrence`. */
export function splitKey(key: string): [string, string, number] {
  const [account = "", hash = "", occurrence = "0"] = key.split("|");
  return [account, hash, Number(occurrence)];
}

const amountKey = (amount: string) => format2(Decimal.parse(amount.replace(/^-/, "")));

function insertKeys(ctx: FoldContext, row: string, e: FoldEvent, merchant: string): void {
  ctx.sql.insert(
    keys.name,
    "INSERT OR IGNORE INTO fold_txn_keys (row, anchor_ord, amount_key, merchant_key)",
    "(?, ?, ?, ?)",
    row,
    ord(e),
    amountKey(String(e.data.amount)),
    merchant,
  );
}

function loadClaims(ctx: FoldContext, key: string): Claims {
  return (
    ctx.sql.get<Claims>("SELECT * FROM fold_transaction_claims WHERE partition = ?", key) ?? {
      claim: null,
      claim_by: null,
      leg_claim: null,
      leg_claim_by: null,
      leg_on: null,
    }
  );
}

function saveClaims(ctx: FoldContext, key: string, c: Claims): void {
  ctx.sql.write(
    claims.name,
    `INSERT OR REPLACE INTO fold_transaction_claims (partition, claim, claim_by, leg_claim, leg_claim_by, leg_on)
     VALUES (?, ?, ?, ?, ?, ?)`,
    key,
    c.claim,
    c.claim_by,
    c.leg_claim,
    c.leg_claim_by,
    c.leg_on,
  );
}

function applyImport(e: FoldEvent, ctx: FoldContext): void {
  const d = e.data;
  const accountId = ctx.id(ctx.resolve(ACCOUNTS, String(d.account)));
  const name = (d.counterpartyName as string | null) ?? null;
  const description = (d.description as string | null) ?? null;
  const reference = (d.reference as string | null) ?? null;
  // CREATE: the first applied import supplies the row; later members only join it.
  ctx.sql.insert(
    table.name,
    `INSERT OR IGNORE INTO transactions (id, gid, account_id, booking_date, value_date, amount, currency,
       counterparty_name, counterparty_iban, description, reference, bank_transaction_id, source,
       dedup_hash, occurrence, raw, import_batch_id, created_at)`,
    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ctx.id(e.gid),
    e.gid,
    accountId,
    String(d.bookingDate),
    (d.valueDate as string | null) ?? null,
    String(d.amount),
    String(d.currency),
    name,
    (d.counterpartyIban as string | null) ?? null,
    description,
    reference,
    (d.bankTransactionId as string | null) ?? null,
    String(d.source),
    String(d.dedupHash),
    Number(d.occurrence),
    sqlJson(d.raw ?? {}),
    typeof d.batch === "string" ? ctx.id(d.batch) : null,
    ctx.time(e, "created_at"),
  );
  insertKeys(ctx, rowKey(e, ctx), e, merchantKey(name, reference, description));
}

function isTomb(ctx: FoldContext, key: string): boolean {
  return ctx.sql.get("SELECT 1 AS x FROM fold_txn_tombs WHERE partition = ?", key) !== undefined;
}

function applyCashExpense(e: FoldEvent, ctx: FoldContext): void {
  const key = CASHEXP + e.gid;
  if (isTomb(ctx, key)) return; // TOMB
  const d = e.data;
  const title = String(d.title);
  const r = ctx.sql.write(
    table.name,
    `INSERT OR IGNORE INTO transactions (id, gid, account_id, booking_date, value_date, amount, currency,
       counterparty_name, counterparty_iban, description, reference, bank_transaction_id, source,
       dedup_hash, occurrence, raw, import_batch_id, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, 'manual', ?, 0, ?, NULL, ?)`,
    ctx.id(e.gid),
    e.gid,
    ctx.id(ctx.resolve(ACCOUNTS, String(d.account))),
    String(d.bookingDate),
    String(d.amount),
    String(d.currency),
    title,
    title,
    title,
    key,
    sqlJson({ cash_expense: true }),
    ctx.time(e, "created_at"),
  );
  if (r.changes === 0) return; // CREATE: the first applied add stands
  saveClaims(ctx, key, {
    claim: String(d.category),
    claim_by: "manual_txn",
    leg_claim: null,
    leg_claim_by: null,
    leg_on: null,
  });
  insertKeys(ctx, key, e, merchantKey(title, title, title));
}

function applyDelete(e: FoldEvent, ctx: FoldContext): void {
  const key = CASHEXP + e.gid;
  // GUARD: only a held, live cash expense is deleted; anything else is a no-op.
  const r = ctx.sql.write(table.name, "DELETE FROM transactions WHERE dedup_hash = ?", key);
  if (r.changes === 0) return;
  ctx.sql.write(claims.name, "DELETE FROM fold_transaction_claims WHERE partition = ?", key);
  ctx.sql.write(keys.name, "DELETE FROM fold_txn_keys WHERE row = ?", key);
  ctx.sql.write(tombs.name, "INSERT OR IGNORE INTO fold_txn_tombs (partition) VALUES (?)", key);
}

function applyClaim(e: FoldEvent, ctx: FoldContext): void {
  for (const { key, isLeg } of targets(e, ctx)) {
    if (key.startsWith(CASHEXP) && isTomb(ctx, key)) continue; // TOMB: a deleted expense
    const c = loadClaims(ctx, key);
    const source = e.type === "txn.categoryCleared" ? "" : String(e.data.source);
    const by = isLeg ? c.leg_claim_by : c.claim_by;
    if (source.startsWith("llm") && by === "manual_txn") continue; // GUARD
    const category = e.type === "txn.categoryCleared" ? null : String(e.data.category);
    if (isLeg) {
      c.leg_claim = category;
      c.leg_claim_by = source;
    } else {
      const was = legClaimed(c);
      c.claim = category;
      c.claim_by = source;
      if (!legClaimed(c)) c.leg_on = null;
      else if (!was) c.leg_on = ctx.time(e, "created_at");
    }
    saveClaims(ctx, key, c);
  }
}

export const transactionsMaterializer: Materializer = {
  id: "budget.transactions",
  version: 2,
  tables: [table, claims, keys, tombs],
  handles: [IMPORTED, CASH_EXPENSE, DELETED, "txn.categorySet", "txn.categoryCleared"],
  identity: [ACCOUNTS],
  partitions(e, ctx) {
    if (e.type === IMPORTED) return [rowKey(e, ctx)];
    if (e.type === CASH_EXPENSE || e.type === DELETED) return [CASHEXP + e.gid];
    return targets(e, ctx).map((t) => t.key);
  },
  // An import row's members are the imports of its key under every account of the resolved
  // component (a valid import's gid is DET over its key, events.md 7.10), plus each member's cash
  // leg gid, so a re-fold finds every import and claim of the row without a partition index. A cash
  // expense row's only member is its gid.
  subjects(key, ctx) {
    if (key.startsWith(CASHEXP)) return [key.slice(CASHEXP.length)];
    const [root, hash, occurrence] = splitKey(key);
    const out: string[] = [];
    for (const account of ctx.identityMembers(ACCOUNTS, root)) {
      const member = ctx.det("transactions", [account, hash, String(occurrence)]);
      out.push(member, ctx.det("transactions", ["cashleg", member]));
    }
    return out;
  },
  // Each import refers to its member's cash leg gid (gid.md 4.4): leg claims of any member find the
  // row through it, also while the leg is absent (events.md 8.3).
  // Indexed on demand (the first leg claim after new imports): subjects() already yields each
  // member's leg gid, so re-folds never need the index.
  refs: (e, det) => (e.type === IMPORTED ? [det("transactions", ["cashleg", e.gid])] : []),
  refsOnDemand: true,
  // Never deletes a derived leg row (`cashleg:`): the legs deriver owns those (S24 4.1).
  clear(partitions, ctx) {
    for (const key of partitions) {
      if (key.startsWith(CASHEXP)) {
        ctx.sql.write(table.name, "DELETE FROM transactions WHERE dedup_hash = ?", key);
        ctx.sql.write(tombs.name, "DELETE FROM fold_txn_tombs WHERE partition = ?", key);
      } else {
        const [account, hash, occurrence] = splitKey(key);
        ctx.sql.write(
          table.name,
          "DELETE FROM transactions WHERE account_id = ? AND dedup_hash = ? AND occurrence = ?",
          ctx.id(account),
          hash,
          occurrence,
        );
      }
      ctx.sql.write(claims.name, "DELETE FROM fold_transaction_claims WHERE partition = ?", key);
      ctx.sql.write(keys.name, "DELETE FROM fold_txn_keys WHERE row = ?", key);
    }
  },
  apply(e, ctx) {
    if (e.type === IMPORTED) applyImport(e, ctx);
    else if (e.type === CASH_EXPENSE) applyCashExpense(e, ctx);
    else if (e.type === DELETED) applyDelete(e, ctx);
    else applyClaim(e, ctx);
  },
};
