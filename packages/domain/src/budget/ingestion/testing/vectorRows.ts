import { D } from "../../../decimal.js";
import type { RawJson, RawTransaction, TxnSource } from "../types.js";

/** A raw transaction as `parity/python/vectors_budget.py` writes it (`raw_json`). */
export interface RawRow {
  readonly booking_date: string;
  readonly value_date: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly counterparty_name: string | null;
  readonly counterparty_iban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bank_transaction_id: string | null;
  readonly source: TxnSource;
  readonly raw?: { readonly [k: string]: RawJson };
}

export function rawFromRow(row: RawRow): RawTransaction {
  return {
    bookingDate: row.booking_date,
    valueDate: row.value_date,
    amount: D(row.amount),
    currency: row.currency,
    counterpartyName: row.counterparty_name,
    counterpartyIban: row.counterparty_iban,
    description: row.description,
    reference: row.reference,
    bankTransactionId: row.bank_transaction_id,
    source: row.source,
    raw: row.raw ?? {},
  };
}
