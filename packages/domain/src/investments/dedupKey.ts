/**
 * Canonical parts of the investment transaction dedup hashes (port of
 * `modules/investments/importing/dedup.py`; v2 per `packages/store/spec/gid.md` 4.6 and 7.2).
 *
 * Pure: the domain has no sha256. A caller joins the parts with `US` (U+001F) and hashes the UTF-8
 * bytes with sha256 (lower hex): v1 is what Python stores in `inv_transactions.dedup_hash`, v2 is the
 * store's `dedupHashV2` (account gid, the broker's own instrument key instead of the local id).
 *
 * Two sides use this module and must agree on every input:
 * - genesis rebuilds a path from the stored row (quantity and gross are stored as `copy_abs`);
 * - a TS re-import builds it from the parsed row with `dedupInputFromParsed` (which applies
 *   `copy_abs` like `DedupInput.from_parsed`) and counts occurrences over the file with
 *   `hashPathsOfFile`, in the order the Python commit counts them: chronological rank order
 *   (`service/imports.py` commit step 2 sorts the rows by `created_at` = chronological rank before
 *   `dedup_hashes`), not file order.
 */

import { type Decimal, decimalKey } from "../decimal.js";
import { pyStrip } from "../text.js";
import type { CalendarDate } from "./domain/values.js";

/** The unit separator joining every part (dedup.py `_SEPARATOR`). */
export const US = "\u001f";

/** `contract.py` CASHU_NAMESPACE / LEGACY_NAMESPACE (legacy name of the canonical namespace). */
const CASHU_NAMESPACE = "cashu";
const LEGACY_NAMESPACE = "finanse";

/** Which hash a row gets, with everything the parts need. */
export type InvHashPath =
  | {
      readonly kind: "ref";
      readonly brokerId: string;
      readonly ref: string;
      readonly fillKey: string;
      readonly occurrence: number;
    }
  | { readonly kind: "content"; readonly contentKey: string; readonly occurrence: number }
  | {
      readonly kind: "reconciliation";
      readonly instrumentKey: string;
      readonly asOf: CalendarDate;
      readonly type: string;
      readonly quantity: Decimal;
    };

/**
 * The fields of one row that identify it for dedup (dedup.py `DedupInput`). `ref` is already
 * stripped (null when empty), `instrumentKey` is `""` for a cash row: the v1 key is the local
 * instrument id, the v2 key `importing.instrumentKeyV2` over the resolved instrument (gid.md 7.2, one
 * rule for genesis and a re-import).
 */
export interface DedupInput {
  readonly tradeDate: CalendarDate;
  readonly type: string;
  readonly grossAmount: Decimal;
  readonly cashAmount: Decimal;
  readonly ref: string | null;
  readonly instrumentKey: string;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: string | null;
}

/** dedup.py `DedupInput.fill_key`: type, instrument, quantity, price, currency. */
export function fillKey(f: {
  readonly type: string;
  readonly instrumentKey: string;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: string | null;
}): string {
  return [
    f.type,
    f.instrumentKey,
    decimalKey(f.quantity),
    decimalKey(f.price),
    f.currency ?? "",
  ].join(US);
}

/** dedup.py `DedupInput.content_key`: date, type, instrument, quantity, price, gross, cash. */
export function contentKey(f: {
  readonly tradeDate: CalendarDate;
  readonly type: string;
  readonly instrumentKey: string;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly grossAmount: Decimal;
  readonly cashAmount: Decimal;
}): string {
  return [
    f.tradeDate,
    f.type,
    f.instrumentKey,
    decimalKey(f.quantity),
    decimalKey(f.price),
    decimalKey(f.grossAmount),
    decimalKey(f.cashAmount),
  ].join(US);
}

/** dedup.py `DedupInput.occurrence_key`: rows with one key share one occurrence counter. */
export function occurrenceKey(
  f:
    | { readonly kind: "ref"; readonly ref: string; readonly fillKey: string }
    | {
        readonly kind: "content";
        readonly contentKey: string;
      },
): string {
  return f.kind === "ref" ? ["ref", f.ref, f.fillKey].join(US) : ["content", f.contentKey].join(US);
}

/** dedup.py `dedup_hash` lines 1-3: the canonical namespace hashes under its legacy name. */
export function brokerIdForHash(broker: string): string {
  return broker === CASHU_NAMESPACE ? LEGACY_NAMESPACE : broker;
}

function tail(path: InvHashPath): string[] {
  switch (path.kind) {
    case "ref":
      return [brokerIdForHash(path.brokerId), path.ref, path.fillKey, String(path.occurrence)];
    case "content":
      return [path.contentKey, String(path.occurrence)];
    case "reconciliation":
      return [path.instrumentKey, path.asOf, path.type, decimalKey(path.quantity)];
  }
}

/** dedup.py `dedup_hash` / `reconciliation_hash` parts: `["v1", kind, accountId, ...]`. */
export function hashPartsV1(path: InvHashPath, accountId: string): string[] {
  return ["v1", path.kind, accountId, ...tail(path)];
}

/** gid.md 4.6 parts: `["v2", kind, accountGid, ...]` (the path carries v2 instrument keys). */
export function hashPartsV2(path: InvHashPath, accountGid: string): string[] {
  return ["v2", path.kind, accountGid, ...tail(path)];
}

/** The ref of a row: Python `external_ref.strip()`, null when missing or blank (`DedupInput.ref`). */
function strippedRef(externalRef: string | null): string | null {
  const ref = externalRef === null ? "" : pyStrip(externalRef);
  return ref === "" ? null : ref;
}

/** What `dedupInputFromParsed` reads of a parsed row (`contract.py` `ParsedTxn`). */
export interface ParsedHashFields {
  readonly tradeDate: CalendarDate;
  readonly type: string;
  readonly currency: string;
  readonly grossAmount: Decimal;
  readonly cashAmount: Decimal;
  readonly externalRef: string | null;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
}

/** dedup.py `DedupInput.from_parsed`: quantity and gross as `copy_abs`, the ref stripped. */
export function dedupInputFromParsed(row: ParsedHashFields, instrumentKey: string): DedupInput {
  return {
    tradeDate: row.tradeDate,
    type: row.type,
    grossAmount: row.grossAmount.copyAbs(),
    cashAmount: row.cashAmount,
    ref: strippedRef(row.externalRef),
    instrumentKey,
    quantity: row.quantity === null ? null : row.quantity.copyAbs(),
    price: row.price,
    currency: row.currency,
  };
}

/**
 * dedup.py `DedupInput.from_transaction` for a stored row: values as stored (already `copy_abs`),
 * the ref stripped. Genesis builds its v1 inputs (occurrence recovery) and v2 inputs with this.
 */
export function dedupInputFromStored(row: ParsedHashFields, instrumentKey: string): DedupInput {
  return {
    tradeDate: row.tradeDate,
    type: row.type,
    grossAmount: row.grossAmount,
    cashAmount: row.cashAmount,
    ref: strippedRef(row.externalRef),
    instrumentKey,
    quantity: row.quantity,
    price: row.price,
    currency: row.currency,
  };
}

/** The ref or content path of one row with a given occurrence (dedup.py `dedup_hash`). */
export function hashPathOf(row: DedupInput, brokerId: string, occurrence: number): InvHashPath {
  return row.ref === null
    ? { kind: "content", contentKey: contentKey(row), occurrence }
    : { kind: "ref", brokerId, ref: row.ref, fillKey: fillKey(row), occurrence };
}

/** The occurrence key of a row (dedup.py `DedupInput.occurrence_key`). */
export function occurrenceKeyOf(row: DedupInput): string {
  return row.ref === null
    ? occurrenceKey({ kind: "content", contentKey: contentKey(row) })
    : occurrenceKey({ kind: "ref", ref: row.ref, fillKey: fillKey(row) });
}

/**
 * dedup.py `dedup_hashes`: the path of every row of one file in input order, occurrences counted
 * per occurrence key. Pass the rows in chronological rank order to reproduce the stored hashes.
 */
export function hashPathsOfFile(rows: readonly DedupInput[], brokerId: string): InvHashPath[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = occurrenceKeyOf(row);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return hashPathOf(row, brokerId, occurrence);
  });
}
