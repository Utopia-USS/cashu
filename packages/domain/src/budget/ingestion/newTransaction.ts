/** A parsed row shaped for storage (Python `normalize.to_transaction`, minus account and batch). */

import type { IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import { normalizeIban } from "../../iban.js";
import { pyUpper } from "../../text.js";
import type { RawJson, RawTransaction, TxnSource } from "./types.js";

/** The fields of a `txn.imported` event a new row carries (the store adds account and batch). */
export interface NewTransaction {
  readonly bookingDate: IsoDate;
  readonly valueDate: IsoDate | null;
  /** As parsed (scale kept); the store renders it in plain notation. */
  readonly amount: Decimal;
  /** `str.upper()` of the parsed currency; not validated here (the store command refuses a non-ISO code). */
  readonly currency: string;
  readonly counterpartyName: string | null;
  /** `normalize_iban(raw) or None`. */
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly source: TxnSource;
  /** `dedupHashV2` of the row. */
  readonly dedupHash: string;
  /** How many stored or earlier rows of this import share the hash (0 for the first). */
  readonly occurrence: number;
  readonly raw: { readonly [k: string]: RawJson };
}

export function toNewTransaction(
  raw: RawTransaction,
  dedupHash: string,
  occurrence: number,
): NewTransaction {
  return {
    bookingDate: raw.bookingDate,
    valueDate: raw.valueDate,
    amount: raw.amount,
    currency: pyUpper(raw.currency),
    counterpartyName: raw.counterpartyName,
    counterpartyIban: normalizeIban(raw.counterpartyIban) || null,
    description: raw.description,
    reference: raw.reference,
    bankTransactionId: raw.bankTransactionId,
    source: raw.source,
    dedupHash,
    occurrence,
    raw: raw.raw,
  };
}
