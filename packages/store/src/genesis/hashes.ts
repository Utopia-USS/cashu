// Transaction dedup hashes of genesis (S26 spec 4.2, 4.5, 6.3; gid.md 4.4, 4.6, 7, 7.2, 7.4).
//
// Budget: `dedupHashV2` (the domain port) over the stored columns; rows whose stored v1 hash differs
// from `sha1(account_id "|" contentKeyV2)` are counted (`budget_v1_mismatch`), the row still uses v2.
// Investments (invHashes.ts): occurrence recovery through the v1 hash, then v2. Both keep every row
// on a collision (gid.md 7.4) through `resolveCollisions`.
import { budget, D, sha1Hex } from "@cashu/domain";
import { isJsonObject, rowIdOf } from "./idFields.js";
import type { GenesisCounters } from "./report.js";
import type { TransactionRow } from "./rows.js";

/** The local account id -> its gid in this vault (undefined: not exported here). */
export type AccountGids = (accountId: number) => string | undefined;

/**
 * Claims of `(account gid, hash, occurrence)`: rows in id order, the first row keeps its own
 * occurrence, each later row takes the smallest free occurrence above its own (gid.md 7.4).
 * `claimOf(row, k)` is the claim of the row at occurrence k.
 */
export function resolveCollisions<R extends { readonly id: number }>(
  rows: readonly R[],
  claimOf: (row: R, occurrence: number) => string,
  occurrenceOf: (row: R) => number,
): { readonly occurrences: ReadonlyMap<number, number>; readonly collisions: number } {
  const claimed = new Set<string>();
  const occurrences = new Map<number, number>();
  const losers: R[] = [];
  for (const row of rows) {
    const claim = claimOf(row, occurrenceOf(row));
    if (claimed.has(claim)) {
      losers.push(row);
    } else {
      claimed.add(claim);
      occurrences.set(row.id, occurrenceOf(row));
    }
  }
  for (const row of losers) {
    let k = occurrenceOf(row) + 1;
    while (claimed.has(claimOf(row, k))) k++;
    claimed.add(claimOf(row, k));
    occurrences.set(row.id, k);
  }
  return { occurrences, collisions: losers.length };
}

/** How genesis maps a budget transaction (spec 4.2); a cash mirror leg is recognised first. */
export type BudgetTxnKind = "bank" | "cashExpense" | "cashLeg";

function cashLegOf(row: TransactionRow): unknown {
  return isJsonObject(row.raw) ? (row.raw.cash_leg_of ?? null) : null;
}

export function budgetTxnKind(row: TransactionRow): BudgetTxnKind {
  if (row.dedupHash.startsWith("cashleg:") || cashLegOf(row) !== null) return "cashLeg";
  return row.dedupHash.startsWith("cashexp:") ? "cashExpense" : "bank";
}

/** The local id of the row a cash leg mirrors: `raw.cash_leg_of`, else the id after `cashleg:`. */
export function cashLegSource(row: TransactionRow): number | undefined {
  const leg = cashLegOf(row);
  if (leg !== null) return rowIdOf(leg);
  return rowIdOf(row.dedupHash.slice("cashleg:".length));
}

export interface BudgetHash {
  readonly dedupHash: string;
  readonly occurrence: number;
}

/**
 * The v2 hash and occurrence of every bank row (`budgetTxnKind` = bank) of one vault whose account
 * is exported, by local id. Counts `(transactions, budget_v1_mismatch)` (stored hash not
 * reproduced by v1, counts only) and `(transactions, budget_v2_collision)`.
 */
export function budgetHashes(
  rows: readonly TransactionRow[],
  accountGid: AccountGids,
  counters: GenesisCounters,
  ordinal: number,
): ReadonlyMap<number, BudgetHash> {
  const bank: { readonly id: number; readonly row: TransactionRow; readonly hash: string }[] = [];
  let v1Mismatch = 0;
  for (const row of rows) {
    if (budgetTxnKind(row) !== "bank" || accountGid(row.accountId) === undefined) continue;
    const input = {
      bookingDate: row.bookingDate,
      amount: D(row.amount),
      currency: row.currency,
      counterpartyIban: row.counterpartyIban,
      counterpartyName: row.counterpartyName,
      description: row.description,
      reference: row.reference,
    };
    if (sha1Hex(`${row.accountId}|${budget.contentKeyV2(input)}`) !== row.dedupHash) v1Mismatch++;
    bank.push({ id: row.id, row, hash: budget.dedupHashV2(input) });
  }
  const { occurrences, collisions } = resolveCollisions(
    bank,
    (b, k) => `${accountGid(b.row.accountId)}|${b.hash}|${k}`,
    (b) => b.row.occurrence,
  );
  counters.addVault(ordinal, "transactions", "budget_v1_mismatch", v1Mismatch);
  counters.addVault(ordinal, "transactions", "budget_v2_collision", collisions);
  return new Map(
    bank.map((b) => [
      b.id,
      { dedupHash: b.hash, occurrence: occurrences.get(b.id) ?? b.row.occurrence },
    ]),
  );
}
