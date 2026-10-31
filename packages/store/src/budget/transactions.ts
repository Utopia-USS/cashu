// Bank transactions (events.md 8.3, gid.md 4.4): `txn.imported` creates the row on its row key
// (resolve(account), dedupHash, occurrence), so a CSV row and the same Open Banking row collapse once
// their accounts resolve together; the row gid is the anchor (first applied member, N1). Category
// claims are per-transaction registers with a GUARD (an `llm_*` claim never replaces a `manual_txn`
// one); a claim may address the cash leg of any member (`DET(transactions)["cashleg", member]`).
//
// S24 completes this table: cash expenses (`txn.cashExpenseAdded`, `txn.deleted`), the derived
// columns (transfer groups, effective category from claims + rules + engine, cash mirror legs).
import { ACCOUNTS } from "../core/accounts.js";
import { type FoldContext, type FoldEvent, type Materializer, ord } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlJson } from "../sql/values.js";

const table: TableDef = {
  name: "transactions",
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
  ],
};

interface Claims {
  claim: string | null;
  claim_by: string | null;
  leg_claim: string | null;
  leg_claim_by: string | null;
}

interface Target {
  readonly key: string;
  readonly isLeg: boolean;
}

const IMPORTED = "txn.imported";

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

/**
 * Rows a claim addresses: the row of a member gid, or (for a leg gid) the row of the member whose
 * import refers to that leg gid. Leg gids are never computed backwards: each import records its leg
 * gid as a ref once, when it enters the log.
 */
function targets(e: FoldEvent, ctx: FoldContext): Target[] {
  const direct = rowOf(e.gid, e, ctx);
  if (direct !== undefined) return [{ key: direct, isLeg: false }];
  const keys = new Set<string>();
  for (const g of ctx.referrers(e.gid)) {
    const key = rowOf(g, e, ctx);
    if (key !== undefined) keys.add(key);
  }
  return [...keys].map((key) => ({ key, isLeg: true }));
}

function splitKey(key: string): [string, string, number] {
  const [account = "", hash = "", occurrence = "0"] = key.split("|");
  return [account, hash, Number(occurrence)];
}

export const transactionsMaterializer: Materializer = {
  id: "budget.transactions",
  version: 1,
  tables: [table, claims],
  handles: ["txn.imported", "txn.categorySet", "txn.categoryCleared"],
  identity: [ACCOUNTS],
  partitions(e, ctx) {
    return e.type === IMPORTED ? [rowKey(e, ctx)] : targets(e, ctx).map((t) => t.key);
  },
  // A row's members are the imports of its key under every account of the resolved component (a
  // valid import's gid is DET over its key, events.md 7.10), plus each member's cash leg gid, so a
  // re-fold finds every import and claim of the row without a partition index.
  subjects(key, ctx) {
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
  clear(keys, ctx) {
    for (const key of keys) {
      const [account, hash, occurrence] = splitKey(key);
      ctx.sql.write(
        table.name,
        "DELETE FROM transactions WHERE account_id = ? AND dedup_hash = ? AND occurrence = ?",
        ctx.id(account),
        hash,
        occurrence,
      );
      ctx.sql.write(claims.name, "DELETE FROM fold_transaction_claims WHERE partition = ?", key);
    }
  },
  apply(e, ctx) {
    if (e.type === IMPORTED) {
      const d = e.data;
      const accountId = ctx.id(ctx.resolve(ACCOUNTS, String(d.account)));
      // CREATE: the first applied import supplies the row; later members only join it.
      ctx.sql.write(
        table.name,
        `INSERT OR IGNORE INTO transactions (id, gid, account_id, booking_date, value_date, amount, currency,
           counterparty_name, counterparty_iban, description, reference, bank_transaction_id, source,
           dedup_hash, occurrence, raw, import_batch_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.id(e.gid),
        e.gid,
        accountId,
        String(d.bookingDate),
        (d.valueDate as string | null) ?? null,
        String(d.amount),
        String(d.currency),
        (d.counterpartyName as string | null) ?? null,
        (d.counterpartyIban as string | null) ?? null,
        (d.description as string | null) ?? null,
        (d.reference as string | null) ?? null,
        (d.bankTransactionId as string | null) ?? null,
        String(d.source),
        String(d.dedupHash),
        Number(d.occurrence),
        sqlJson(d.raw ?? {}),
        typeof d.batch === "string" ? ctx.id(d.batch) : null,
        ctx.time(e, "created_at"),
      );
      return;
    }
    for (const { key, isLeg } of targets(e, ctx)) {
      const c = ctx.sql.get<Claims>(
        "SELECT * FROM fold_transaction_claims WHERE partition = ?",
        key,
      ) ?? { claim: null, claim_by: null, leg_claim: null, leg_claim_by: null };
      const source = e.type === "txn.categoryCleared" ? "" : String(e.data.source);
      const by = isLeg ? c.leg_claim_by : c.claim_by;
      if (source.startsWith("llm") && by === "manual_txn") continue; // GUARD
      const category = e.type === "txn.categoryCleared" ? null : String(e.data.category);
      if (isLeg) {
        c.leg_claim = category;
        c.leg_claim_by = source;
      } else {
        c.claim = category;
        c.claim_by = source;
      }
      ctx.sql.write(
        claims.name,
        `INSERT OR REPLACE INTO fold_transaction_claims (partition, claim, claim_by, leg_claim, leg_claim_by)
         VALUES (?, ?, ?, ?, ?)`,
        key,
        c.claim,
        c.claim_by,
        c.leg_claim,
        c.leg_claim_by,
      );
      if (isLeg) continue;
      const [account, hash, occurrence] = splitKey(key);
      // TRANSITIONAL(S24): the column shows the per-transaction claim only; S24 derives the effective
      // category (manual claim > structural transfer / locked rule / loan pattern > llm claim > engine).
      ctx.sql.write(
        table.name,
        `UPDATE transactions SET category = ?, category_source = ?
         WHERE account_id = ? AND dedup_hash = ? AND occurrence = ?`,
        category,
        category === null ? null : source,
        ctx.id(account),
        hash,
        occurrence,
      );
    }
  },
};
