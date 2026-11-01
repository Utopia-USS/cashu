/** Hand-built categorize rows for the oracle translations (tests only). */
import { D } from "../../../decimal.js";
import type { CategorizeRow, CategoryClaimValue } from "../effective.js";

let next = 0;

export interface RowSpec {
  readonly date?: string;
  readonly amount: string;
  readonly reference?: string | null;
  readonly description?: string | null;
  readonly cp?: string | null;
  readonly iban?: string | null;
  readonly currency?: string;
  readonly internal?: boolean;
  readonly cash?: boolean;
  readonly claim?: CategoryClaimValue | null;
  readonly key?: string;
}

/** A row like `RawTransaction(...)` ingested into a bank account (or the cash pool with `cash`). */
export function row(s: RowSpec): CategorizeRow {
  next++;
  return {
    key: s.key ?? `r${next}`,
    onCashAccount: s.cash ?? false,
    bookingDate: s.date ?? "2026-01-01",
    amount: D(s.amount),
    currency: s.currency ?? "PLN",
    counterpartyName: s.cp ?? null,
    counterpartyIban: s.iban ?? null,
    reference: s.reference ?? null,
    description: s.description ?? null,
    isInternalTransfer: s.internal ?? false,
    claim: s.claim ?? null,
  };
}

/** `_monthly`: four rows, months 5-8 on `day`, title in reference and description. */
export function monthly(
  title: string,
  amount: string,
  opts: { cp?: string; iban?: string; currency?: string; day?: number } = {},
): CategorizeRow[] {
  const day = String(opts.day ?? 5).padStart(2, "0");
  return [5, 6, 7, 8].map((m) =>
    row({
      date: `2026-0${m}-${day}`,
      amount,
      reference: title,
      description: title,
      cp: opts.cp ?? null,
      iban: opts.iban ?? null,
      currency: opts.currency ?? "PLN",
    }),
  );
}
