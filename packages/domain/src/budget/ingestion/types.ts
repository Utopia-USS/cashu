/** The parsed, not-yet-stored shapes of budget ingestion (Python `normalize.RawTransaction`, `ParsedStatement`). */

import type { IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";

/** Python `core.models.Source` values. */
export type TxnSource = "open_banking" | "csv" | "manual" | "connector";

export type RawJson =
  | string
  | number
  | boolean
  | null
  | readonly RawJson[]
  | { readonly [k: string]: RawJson };

/** One transaction as a parser read it (Python `RawTransaction`). */
export interface RawTransaction {
  readonly bookingDate: IsoDate;
  readonly valueDate: IsoDate | null;
  /** Signed (negative = outflow), the parser's scale kept (`"-12,50"` -> exponent -2). */
  readonly amount: Decimal;
  /** As parsed: neither validated nor upper-cased. PARITY(Q7): Python takes the cell or `#Waluta` as is. */
  readonly currency: string;
  readonly counterpartyName: string | null;
  /** The raw cell (apostrophe, spaces kept); normalised only by `toNewTransaction` and the hash. */
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly source: TxnSource;
  /** `{row}` (bank CSV), `{row, type}` (Pekao) or `{format, row, source}` (cashu-budget-import). */
  readonly raw: { readonly [k: string]: RawJson };
}

export interface DatedAmount {
  readonly date: IsoDate;
  readonly amount: Decimal;
}

/**
 * Where `accountNumber` came from: a preamble line (mBank), the summary row (Erste), the account seen
 * most often (Pekao), the first account number anywhere in the text, or the document's `iban`.
 * PARITY(Q6): a `"scan"` number is often a counterparty's; the import asks rather than trusting it.
 */
export type AccountNumberOrigin = "preamble" | "summary" | "inferred" | "scan" | "document";

export interface ParsedStatement {
  /** Institution id. */
  readonly bank: string;
  readonly accountNumber: string | null;
  /** Null exactly when `accountNumber` is null. */
  readonly accountNumberOrigin: AccountNumberOrigin | null;
  readonly accountName: string | null;
  readonly currency: string;
  readonly transactions: readonly RawTransaction[];
  /** Running-balance snapshots in file order (not collapsed per day). */
  readonly balances: readonly DatedAmount[];
  /** Explicit closing balances (the budget import format's `balances`). */
  readonly closingBalances: readonly DatedAmount[];
  /** Rows after the header dropped for no date or no amount (blank rows not counted). */
  readonly skippedRows: number;
}

/** Python `RawTransaction.memo`: description and reference joined by a space, empty parts left out. */
export function memo(t: Pick<RawTransaction, "description" | "reference">): string {
  return [t.description, t.reference].filter((p) => p).join(" ");
}
