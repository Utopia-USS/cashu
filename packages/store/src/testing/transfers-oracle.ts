// The internal-transfer oracle of the store tests (S24b, D-24.1 / D-24.2): the S08 domain matcher
// (`budget.matchTransfers`) over a plain read of the view, written independently of the
// `budget.transfers` deriver (its own SQL, account keys from the raw `iban` through the domain
// `ibanKey`, not the view's `iban_match`), compared with the view's derived columns. Synthetic data
// only.
import { budget, D } from "@cashu/domain";
import { expect } from "vitest";
import type { Store } from "../materialize.js";

interface ViewRow {
  gid: string;
  account: string;
  dedup_hash: string;
  occurrence: number;
  booking_date: string;
  amount: string;
  counterparty_iban: string | null;
  is_internal_transfer: number;
  transfer_group_id: string | null;
}

/** Row gid -> `[is_internal_transfer, transfer_group_id]`: the recompute, and what the view shows. */
function transferOracle(store: Store): {
  expected: Map<string, [number, string | null]>;
  actual: Map<string, [number, string | null]>;
  pairs: number;
} {
  const read = store.read.bind(store);
  const accounts = budget.transferAccountKeys(
    read<{ gid: string; iban: string | null }>("SELECT gid, iban FROM accounts").map((a) => ({
      key: a.gid,
      iban: a.iban,
    })),
  );
  const anchors = new Map(
    read<{ row: string; anchor_ord: string }>("SELECT row, anchor_ord FROM fold_txn_keys").map(
      (k) => [k.row, k.anchor_ord],
    ),
  );
  const rows = read<ViewRow>(
    `SELECT t.gid, v.gid AS account, t.dedup_hash, t.occurrence, t.booking_date, t.amount,
       t.counterparty_iban, t.is_internal_transfer, t.transfer_group_id
     FROM transactions t JOIN view_ids v ON v.id = t.account_id`,
  );
  // Python id order: a bank row or cash expense by its anchor, a cash leg right after its source.
  const anchorOf = new Map<string, string>();
  for (const r of rows) {
    if (r.dedup_hash.startsWith("cashleg:")) continue;
    const partition = r.dedup_hash.startsWith("cashexp:")
      ? r.dedup_hash
      : `${r.account}|${r.dedup_hash}|${r.occurrence}`;
    const anchor = anchors.get(partition);
    if (anchor !== undefined) anchorOf.set(r.gid, anchor);
  }
  for (const r of rows) {
    if (!r.dedup_hash.startsWith("cashleg:")) continue;
    const src = anchorOf.get(r.dedup_hash.slice("cashleg:".length));
    if (src !== undefined) anchorOf.set(r.gid, `${src}~`);
  }
  const ordered = rows
    .filter((r) => anchorOf.has(r.gid))
    .sort((a, b) => ((anchorOf.get(a.gid) ?? "") < (anchorOf.get(b.gid) ?? "") ? -1 : 1));
  const pairs = budget.matchTransfers(
    ordered.map((r) => ({
      key: r.gid,
      account: r.account,
      bookingDate: r.booking_date,
      amount: D(r.amount),
      counterpartyIban: r.counterparty_iban,
    })),
    accounts,
  );
  const expected = new Map<string, [number, string | null]>(rows.map((r) => [r.gid, [0, null]]));
  for (const p of pairs) {
    expected.set(p.out, [1, p.out]);
    expected.set(p.in, [1, p.out]);
  }
  const actual = new Map<string, [number, string | null]>(
    rows.map((r) => [r.gid, [r.is_internal_transfer, r.transfer_group_id]]),
  );
  return { expected, actual, pairs: pairs.length };
}

/** The view's transfer columns equal the domain recompute; returns the number of pairs. */
export function expectTransfersRecomputed(store: Store): number {
  const { expected, actual, pairs } = transferOracle(store);
  expect(actual).toEqual(expected);
  return pairs;
}
