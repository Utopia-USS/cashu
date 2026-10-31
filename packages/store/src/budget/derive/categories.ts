// Deriver budget.categories (S24 4.3, events.md 8.3 / 9): the effective `category` /
// `category_source` of every transaction row except the cash legs (the legs deriver writes theirs).
//
// TRANSITIONAL(S24c): phase 1 applies the claims only (precedence steps 1, 2 and 4: a row on a cash
// account takes its claim; a `manual_txn` claim; an `llm_full` / `llm_fallback` claim). The owner
// decision (structural transfer, locked merchant rule, loan payment pattern) and the rule engine
// (S09) are not ported yet, so every other row has `category = NULL`, never a guessed value; parity
// lists those columns as pending.
import type { DeriveContext, Deriver } from "../../engine/types.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { selectIn } from "./keys.js";

interface ClaimRow {
  partition: string;
  claim: string | null;
  claim_by: string | null;
}

/** The effective category of a row from its claim register (phase 1). */
function effective(c: ClaimRow | undefined): [string | null, string | null] {
  if (c === undefined || c.claim === null) return [null, null];
  return [c.claim, c.claim_by];
}

function setRow(ctx: DeriveContext, key: string, value: [string | null, string | null]): void {
  const [category, source] = value;
  if (key.startsWith(CASHEXP)) {
    ctx.sql.write(
      TRANSACTIONS,
      `UPDATE transactions SET category = ?, category_source = ?
       WHERE dedup_hash = ? AND (category IS NOT ? OR category_source IS NOT ?)`,
      category,
      source,
      key,
      category,
      source,
    );
    return;
  }
  const [root, hash, occurrence] = splitKey(key);
  ctx.sql.write(
    TRANSACTIONS,
    `UPDATE transactions SET category = ?, category_source = ?
     WHERE account_id = (SELECT id FROM view_ids WHERE gid = ?) AND dedup_hash = ? AND occurrence = ?
       AND (category IS NOT ? OR category_source IS NOT ?)`,
    category,
    source,
    root,
    hash,
    occurrence,
    category,
    source,
  );
}

export const categoriesDeriver: Deriver = {
  id: "budget.categories",
  version: 1,
  writes: [{ table: TRANSACTIONS, columns: ["category", "category_source"] }],
  inputs: ["budget.transactions"],
  derive(dirty, ctx) {
    const p = dirty.get("budget.transactions");
    if (p === undefined || p === "all") return;
    // A dirty row without a claim register was (re)inserted with NULL categories: nothing to do.
    for (const c of selectIn<ClaimRow>(
      ctx.sql,
      "SELECT partition, claim, claim_by FROM fold_transaction_claims WHERE partition IN (%IN%)",
      [...p],
    )) {
      setRow(ctx, c.partition, effective(c));
    }
  },
  deriveAll(ctx) {
    const claims = new Map(
      ctx.sql
        .all<ClaimRow>("SELECT partition, claim, claim_by FROM fold_transaction_claims")
        .map((c) => [c.partition, c]),
    );
    for (const c of claims.values()) setRow(ctx, c.partition, effective(c));
    // Rows showing a category without a register (none after a full re-fold; kept exact anyway).
    for (const r of ctx.sql.all<{ id: number; key: string }>(
      `SELECT t.id, CASE WHEN t.dedup_hash LIKE '${CASHEXP}%' THEN t.dedup_hash
         ELSE v.gid || '|' || t.dedup_hash || '|' || t.occurrence END AS key
       FROM transactions t JOIN view_ids v ON v.id = t.account_id
       WHERE t.category IS NOT NULL AND t.dedup_hash NOT LIKE '${CASHLEG}%'`,
    )) {
      if (!claims.has(r.key) || claims.get(r.key)?.claim === null) {
        ctx.sql.write(
          TRANSACTIONS,
          "UPDATE transactions SET category = NULL, category_source = NULL WHERE id = ?",
          r.id,
        );
      }
    }
  },
};
