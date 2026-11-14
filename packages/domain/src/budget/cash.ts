/**
 * The cash pool (`modules/budget/cash.py`): physical cash as one virtual account per currency, worth the
 * running sum of its transactions. A bank withdrawal the owner marks `cash_withdrawal` is mirrored into
 * the pool as a positive leg (so the withdrawal is net-worth neutral); a manually logged cash expense
 * draws the pool down (a real expense).
 *
 * Only the pure rules live here; the pool account, the leg rows and the commands are the store's. The
 * Polish strings are MATCHING DATA written by Python (stored on rows, compared by other devices): never
 * translate them; `matchingData.test.ts` checks them byte for byte against the live Python source.
 */

import type { IsoDate } from "../dates.js";
import { DEFAULT_CONTEXT, type Decimal } from "../decimal.js";

/** `AccountType.CASH`: the type id of a cash pool account. */
export const CASH_ACCOUNT_TYPE = "cash";
/** The category key that makes a mirror leg (the taxonomy owns the full list, S09). */
export const CASH_WITHDRAWAL = "cash_withdrawal";
/** `category_source` of a leg nobody re-categorized. */
export const CASH_LEG_SOURCE = "cash_leg";
/** `category_source` of a category the owner set by hand (`service.set_transaction_category`). */
export const MANUAL_CATEGORY_SOURCE = "manual_txn";
/** cash.py:89-91: the leg's counterparty name and reference, and its last-resort description. */
export const CASH_LEG_TEXT = "Wypłata gotówki";
/** cash.py:56: the pool's name in the profile's base currency. */
export const CASH_POOL_NAME = "Gotówka";
/** `dedup_hash` prefix of a mirror leg (Python `cashleg:<bank txn id>`; store `cashleg:<anchor gid>`). */
export const CASH_LEG_PREFIX = "cashleg:";
/** `dedup_hash` prefix of a manual cash expense (`cashexp:<unique id>`). */
export const CASH_EXPENSE_PREFIX = "cashexp:";

/** cash.py:46: the pool account's external id (bank `manual`, one pool per currency). */
export function cashPoolExternalId(currency: string): string {
  return `cash:${currency}`;
}

/**
 * cash.py:56: "Gotówka" in the profile's base currency, else "Gotówka (<CUR>)". PARITY(Q12): decided
 * once, when the pool is created; Python never renames it when the base currency changes later.
 */
export function cashPoolName(currency: string, baseCurrency: string): string {
  return currency === baseCurrency ? CASH_POOL_NAME : `${CASH_POOL_NAME} (${currency})`;
}

/** A row's category claim (the store's claim register value). */
export interface CategoryClaim {
  readonly category: string;
  readonly source: string;
}

/**
 * Whether a bank row has a mirror leg (cash.py:77 with service.py:256-261, D-24.3): its claim is the
 * owner's manual `cash_withdrawal` and the row is not itself on a cash account. A locked merchant rule
 * to `cash_withdrawal` makes no leg. Whether the pool account exists is the store's check.
 */
export function hasCashLeg(claim: CategoryClaim | null, accountType: string): boolean {
  return (
    claim !== null &&
    claim.category === CASH_WITHDRAWAL &&
    claim.source === MANUAL_CATEGORY_SOURCE &&
    accountType !== CASH_ACCOUNT_TYPE
  );
}

/** The bank withdrawal a leg mirrors. */
export interface LegSource {
  readonly bookingDate: IsoDate;
  readonly valueDate: IsoDate | null;
  readonly amount: Decimal;
  readonly currency: string;
  readonly description: string | null;
  readonly reference: string | null;
}

/** The leg row's own columns (the store adds ids, the pool account, `dedup_hash` and `raw`). */
export interface CashLegFields {
  readonly bookingDate: IsoDate;
  readonly valueDate: IsoDate | null;
  /** Python `abs(amount)`, rounded to the 28-digit context (D-08.3 / Q10). */
  readonly amount: Decimal;
  readonly currency: string;
  readonly counterpartyName: string;
  /** `reference or description or "Wypłata gotówki"` (an empty string is falsy, as in Python). */
  readonly description: string;
  readonly reference: string;
  readonly category: string;
  readonly categorySource: string;
}

/**
 * cash.py:sync_cash_leg, create branch (82-98). `legClaim` is a category claim addressed to the leg
 * itself (events.md 8.3); without one the leg is `cash_withdrawal` / `cash_leg`. Python's update branch
 * (100-104, amount / booking date / currency only) is unreachable here: source rows are immutable (Q11).
 */
export function cashLegFields(source: LegSource, legClaim: CategoryClaim | null): CashLegFields {
  return {
    bookingDate: source.bookingDate,
    valueDate: source.valueDate,
    amount: source.amount.abs(DEFAULT_CONTEXT),
    currency: source.currency,
    counterpartyName: CASH_LEG_TEXT,
    description: source.reference || source.description || CASH_LEG_TEXT,
    reference: CASH_LEG_TEXT,
    category: legClaim?.category ?? CASH_WITHDRAWAL,
    categorySource: legClaim?.source ?? CASH_LEG_SOURCE,
  };
}

/**
 * cash.py:125-127: a cash expense is `-abs(amount)`; zero (also `-0`) is refused. The category check
 * (`taxonomy.CATEGORY_KEYS`) is the command's (S24c). FIX(Q14): Python would store a NaN or -Infinity
 * expense for a non-finite input; a domain `Decimal` is always finite, so the caller's parse refuses
 * those inputs before this point.
 */
export function cashExpenseAmount(
  amount: Decimal,
):
  | { readonly ok: true; readonly amount: Decimal }
  | { readonly ok: false; readonly reason: "zero_amount" } {
  const out = amount.abs(DEFAULT_CONTEXT).neg(DEFAULT_CONTEXT);
  if (out.isZero()) return { ok: false, reason: "zero_amount" };
  return { ok: true, amount: out };
}
