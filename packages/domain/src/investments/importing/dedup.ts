/**
 * Deduplication hashes of imported transactions (port of `importing/dedup.py`; the store keeps them in
 * a unique column).
 *
 * R8: with an external ref the hash covers (account, broker, ref, fill key = type, instrument,
 * quantity, price, currency) plus an occurrence index counted per identical fill, so rows sharing a ref
 * (partial fills of one order, an order and its fee row) map to their own hashes whatever their order
 * in the file or overlap between exports. Without a ref the hash covers the full content plus an
 * occurrence index among identical rows of the same file: two identical legitimate rows both import, a
 * re-import of the same file is recognized. Decimals compare by value (`10.50` equals `10.5`).
 *
 * The algorithm is versioned (`version`, Python's `v1`); gid.md 4.6 defines `v2` over the same parts
 * with gids and broker instrument keys, which a caller gets by passing its own `instrumentKey` and
 * `version`.
 */

import { type Decimal, decimalKey } from "../../decimal.js";
import { sha256Hex } from "../../sha256.js";
import { pyStrip } from "../../text.js";
import {
  type AccountId,
  type CalendarDate,
  InvariantError,
  type Transaction,
  type TxnType,
} from "../domain/index.js";
import { CASHU_NAMESPACE, LEGACY_NAMESPACE, type ParsedTxn } from "./contract.js";

const SEPARATOR = "\u001f";
export const HASH_VERSION = "v1";

export { decimalKey };

/** The fields of one transaction that identify it for deduplication. */
export interface DedupInput {
  readonly tradeDate: CalendarDate;
  readonly type: TxnType;
  readonly grossAmount: Decimal;
  readonly cashAmount: Decimal;
  /** The broker's row or order id; when present the hash uses it plus `fillKey`. */
  readonly externalRef: string | null;
  /**
   * The resolved instrument id (stable across re-imports: the resolver finds the same instrument
   * through its aliases), null for cash rows.
   */
  readonly instrumentKey: string | null;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: string | null;
}

export type DedupInputInit = Pick<DedupInput, "tradeDate" | "type" | "grossAmount" | "cashAmount"> &
  Partial<DedupInput>;

/** `DedupInput(...)` with Python's defaults (every optional field null). */
export function dedupInput(init: DedupInputInit): DedupInput {
  return Object.freeze({
    externalRef: init.externalRef ?? null,
    instrumentKey: init.instrumentKey ?? null,
    quantity: init.quantity ?? null,
    price: init.price ?? null,
    currency: init.currency ?? null,
    tradeDate: init.tradeDate,
    type: init.type,
    grossAmount: init.grossAmount,
    cashAmount: init.cashAmount,
  });
}

/** `DedupInput.from_transaction`. */
export function dedupInputFromTransaction(txn: Transaction): DedupInput {
  return dedupInput({
    tradeDate: txn.tradeDate,
    type: txn.type,
    grossAmount: txn.grossAmount,
    cashAmount: txn.cashAmount,
    externalRef: txn.externalRef,
    instrumentKey: txn.instrumentId,
    quantity: txn.quantity,
    price: txn.price,
    currency: txn.currency,
  });
}

/** `DedupInput.from_parsed`: gross and quantity as absolute values. */
export function dedupInputFromParsed(txn: ParsedTxn, instrumentKey: string | null): DedupInput {
  return dedupInput({
    tradeDate: txn.tradeDate,
    type: txn.type,
    grossAmount: txn.grossAmount.copyAbs(),
    cashAmount: txn.cashAmount,
    externalRef: txn.externalRef,
    instrumentKey,
    quantity: txn.quantity === null ? null : txn.quantity.copyAbs(),
    price: txn.price,
    currency: txn.currency,
  });
}

/** `DedupInput.ref`: the trimmed external ref, null when blank. */
export function dedupRef(row: DedupInput): string | null {
  const ref = row.externalRef === null ? null : pyStrip(row.externalRef);
  return ref || null;
}

/** Key of the content variant, shared by rows that are identical for dedup purposes. */
export function contentKey(row: DedupInput): string {
  return [
    row.tradeDate,
    row.type,
    row.instrumentKey ?? "",
    decimalKey(row.quantity),
    decimalKey(row.price),
    decimalKey(row.grossAmount),
    decimalKey(row.cashAmount),
  ].join(SEPARATOR);
}

/**
 * What tells apart rows sharing one external ref: type, instrument, quantity, price and currency.
 * Amounts and dates are left out, so a re-export that rounds cash differently still matches.
 */
export function fillKey(row: DedupInput): string {
  return [
    row.type,
    row.instrumentKey ?? "",
    decimalKey(row.quantity),
    decimalKey(row.price),
    row.currency ?? "",
  ].join(SEPARATOR);
}

/** `DedupInput.occurrence_key`: rows with the same key count occurrences together. */
export function occurrenceKey(row: DedupInput): string {
  const ref = dedupRef(row);
  if (ref !== null) return ["ref", ref, fillKey(row)].join(SEPARATOR);
  return ["content", contentKey(row)].join(SEPARATOR);
}

export interface DedupScope {
  readonly accountId: AccountId | string;
  readonly brokerId: string;
  /** Hash algorithm tag (default `v1`, Python's). */
  readonly version?: string;
}

/** Lower-case hex SHA-256 identifying `row` in the scope's account (see the module comment). */
export function dedupHash(row: DedupInput, scope: DedupScope, occurrence = 0): string {
  const ref = dedupRef(row);
  // legacy name: hashes keep the pre-rename id, so rows imported before the rename stay duplicates
  const brokerId = scope.brokerId === CASHU_NAMESPACE ? LEGACY_NAMESPACE : scope.brokerId;
  const version = scope.version ?? HASH_VERSION;
  const parts =
    ref !== null
      ? [version, "ref", scope.accountId, brokerId, ref, fillKey(row), String(occurrence)]
      : [version, "content", scope.accountId, contentKey(row), String(occurrence)];
  return sha256Hex(parts.join(SEPARATOR));
}

/**
 * `dedupHash` of every row of one file in input order, with occurrence indexes counted per identical
 * row (per ref and fill key, or per content key). Identical rows are interchangeable, so the set of
 * hashes does not depend on the file order.
 */
export function dedupHashes(rows: Iterable<DedupInput>, scope: DedupScope): readonly string[] {
  const seen = new Map<string, number>();
  const hashes: string[] = [];
  for (const row of rows) {
    const key = occurrenceKey(row);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    hashes.push(dedupHash(row, scope, occurrence));
  }
  return Object.freeze(hashes);
}

/** Dedup hash of a reconciliation correction: applying the same proposal twice inserts it once. */
export function reconciliationHash(
  accountId: AccountId | string,
  instrumentId: string,
  asOf: CalendarDate,
  txnType: TxnType,
  quantity: Decimal,
  version: string = HASH_VERSION,
): string {
  return sha256Hex(
    [version, "reconciliation", accountId, instrumentId, asOf, txnType, decimalKey(quantity)].join(
      SEPARATOR,
    ),
  );
}

/** `DedupInput` of parsed rows with their resolved instrument ids (same length, else a broken invariant). */
export function parsedDedupInputs(
  txns: readonly ParsedTxn[],
  instrumentKeys: readonly (string | null)[],
): readonly DedupInput[] {
  if (txns.length !== instrumentKeys.length) {
    throw new InvariantError("txns and instrument_keys must have the same length");
  }
  return txns.map((txn, i) => dedupInputFromParsed(txn, instrumentKeys[i] ?? null));
}
