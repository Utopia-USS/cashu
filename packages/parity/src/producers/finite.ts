/**
 * Non-finite amounts in a Python dataset (S08 review Q14): Python stores a cash expense of `nan` or
 * `-inf` as `NaN` / `-Infinity`, which a domain `Decimal` cannot hold. Producers that value or match
 * every transaction skip such rows and report how many they skipped (`skipped_non_finite`, written
 * only when not zero, so a dataset holding one fails the comparison visibly instead of crashing the
 * run). Genesis skips them the same way (it decodes amounts strictly).
 */

import { D, type Decimal, DecimalError } from "@cashu/domain";

/** The amount, or null when the text is a non-finite literal (any other bad text still throws). */
function finiteAmount(text: string): Decimal | null {
  try {
    return D(text);
  } catch (e) {
    if (e instanceof DecimalError && e.signal === "NonFinite") return null;
    throw e;
  }
}

/** Rows whose amount is finite, with the parsed amount, and the number skipped. */
export function finiteRows<R extends { readonly amount: string }>(
  rows: readonly R[],
): { readonly rows: (R & { readonly value: Decimal })[]; readonly skipped: number } {
  const out: (R & { readonly value: Decimal })[] = [];
  for (const r of rows) {
    const value = finiteAmount(r.amount);
    if (value !== null) out.push({ ...r, value });
  }
  return { rows: out, skipped: rows.length - out.length };
}
