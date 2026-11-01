/** Reclassify inputs for the oracle translations and the vectors (tests only). */
import { D } from "../../../decimal.js";
import type { Mismatches } from "../../../testing/vectors.js";
import { type ReclassifyRow, txnContext, txnSignature } from "../reclassify.js";

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

export type TextVector = [
  "text",
  { counterpartyName: string | null; reference: string | null; description: string | null },
  string,
  string[],
  string,
  string,
];

/** `txn_signature` / `txn_context` over the adversarial text vectors. */
export function checkTexts(rows: readonly TextVector[], m: Mismatches, offset: number): void {
  rows.forEach(([, t, currency, amounts, signature, context], i) => {
    const row: ReclassifyRow = {
      ...t,
      key: "k",
      bookingDate: "2026-01-05",
      currency,
      onCashAccount: false,
      amount: D(amounts[0] as string),
      counterpartyIban: null,
      isInternalTransfer: false,
      category: null,
      source: null,
    };
    m.check(`#${offset + i} signature`, txnSignature(row), signature);
    m.check(
      `#${offset + i} context`,
      txnContext(
        row,
        amounts.map((a) => D(a)),
      ),
      context,
    );
  });
}
