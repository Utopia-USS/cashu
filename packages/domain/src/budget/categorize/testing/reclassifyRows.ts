/** Reclassify inputs for the hand-written tests (tests only). */
import { D } from "../../../decimal.js";
import type { ReclassifyRow } from "../reclassify.js";

let next = 0;

/** `_txn(session, account_id, amount, cp=, ref=, desc=, cat=, internal=, cp_iban=)` of test_reclassify.py. */
export function rrow(
  amount: string,
  o: {
    cp?: string;
    ref?: string;
    desc?: string;
    cat?: string | null;
    source?: string | null;
    internal?: boolean;
    cpIban?: string;
    cash?: boolean;
    date?: string;
  } = {},
): ReclassifyRow {
  next++;
  return {
    key: `x${next}`,
    bookingDate: o.date ?? "2026-01-01",
    currency: "PLN",
    onCashAccount: o.cash ?? false,
    amount: D(amount),
    counterpartyName: o.cp ?? null,
    counterpartyIban: o.cpIban ?? null,
    reference: o.ref ?? null,
    description: o.desc ?? null,
    isInternalTransfer: o.internal ?? false,
    category: o.cat ?? null,
    source: o.source ?? null,
  };
}
