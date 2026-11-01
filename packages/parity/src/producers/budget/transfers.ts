/**
 * Producer of `budget.transfers` (`parity/python/checks/budget_derived.py:transfers`): per profile with
 * the budget module, the internal-transfer pairs `budget.matchTransfers` recomputes over every stored
 * row, as natural-key groups `[out, in]`, and their drift from the groups Python stored.
 *
 * Inputs (D-08.1): every account of the profile, removed ones too, keyed by `ibanKey` of the RAW stored
 * IBAN; every transaction of the profile in id order (the reader returns `(account_id, id)` order, which
 * would change the inflow tie-break, R3). The `plan` is Python's EXPLAIN QUERY PLAN of the ungrouped
 * query; TS cannot run it, so it writes the plan the port assumes (PARITY(Q2)) and the comparer fails
 * when Python's plan changes.
 */

import { budget, type Decimal, ZERO } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { finiteRows } from "../finite.ts";
import type { OutValue } from "../output.ts";

/** The plan under which Python's inflow candidates come in rowid (id) order. */
export const PYTHON_UNGROUPED_PLAN =
  "SEARCH transactions USING INDEX ix_transactions_transfer_group_id (transfer_group_id=?) | " +
  "LIST SUBQUERY 1 | SEARCH accounts USING COVERING INDEX ix_accounts_profile_id (profile_id=?) | " +
  "CREATE BLOOM FILTER";

type Row = ReturnType<PythonDb["transactions"]>[number] & { readonly value: Decimal };

function compareGroups(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Groups as Python's `_groups`: outflow keys sorted, then the other legs sorted; groups sorted. */
function groupsOf(members: Iterable<readonly Row[]>, key: (id: number) => string): string[][] {
  const out: string[][] = [];
  for (const legs of members) {
    const neg = legs.filter((t) => t.value.lt(ZERO)).map((t) => key(t.id));
    const rest = legs.filter((t) => !t.value.lt(ZERO)).map((t) => key(t.id));
    out.push([...neg.sort(), ...rest.sort()]);
  }
  return out.sort(compareGroups);
}

function profileOut(db: PythonDb, profileId: number): OutValue {
  const key = (id: number): string => db.keys.key("transactions", id);
  // a non-finite amount (Q14) is skipped and counted: Python's own matcher raises on such a row
  const finite = finiteRows(db.transactions(profileId));
  const rows = [...finite.rows].sort((a, b) => a.id - b.id);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const accounts = budget.transferAccountKeys(
    db
      .accounts(profileId, { includeRemoved: true })
      .map((a) => ({ key: String(a.id), iban: a.iban })),
  );
  const pairs = budget.matchTransfers(
    rows.map((r) => ({
      key: String(r.id),
      account: String(r.accountId),
      bookingDate: r.bookingDate,
      amount: r.value,
      counterpartyIban: r.counterpartyIban,
    })),
    accounts,
  );
  const recomputed = groupsOf(
    pairs.map((p) => [byId.get(p.out), byId.get(p.in)].filter((r): r is Row => r !== undefined)),
    key,
  );
  const storedMembers = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.transferGroupId === null) continue;
    storedMembers.set(r.transferGroupId, [...(storedMembers.get(r.transferGroupId) ?? []), r]);
  }
  const stored = groupsOf(storedMembers.values(), key);
  const storedSet = new Set(stored.map((g) => JSON.stringify(g)));
  const same = recomputed.filter((g) => storedSet.has(JSON.stringify(g))).length;
  return {
    pairs: BigInt(pairs.length),
    groups: recomputed,
    drift: {
      only_stored: BigInt(stored.length - same),
      only_recompute: BigInt(recomputed.length - same),
      same: BigInt(same),
      stored_flagged_rows: BigInt(rows.filter((r) => r.isInternalTransfer).length),
    },
    plan: PYTHON_UNGROUPED_PLAN,
    ...(finite.skipped > 0 ? { skipped_non_finite: BigInt(finite.skipped) } : {}),
  };
}

export function produceBudgetTransfers(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes("budget")) continue;
    out[db.keys.key("profiles", p.id)] = profileOut(db, p.id);
  }
  return out;
}
