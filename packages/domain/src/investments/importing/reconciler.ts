/**
 * Compare positions derived from transactions with a broker position export (pure; port of
 * `importing/reconciler.py`).
 *
 * Corrections: missing units become an `adjustment` (opens a lot at the broker's average price, or
 * with unknown cost); surplus units become a `transfer_out` (consumes lots FIFO) because transaction
 * quantities are never negative and an adjustment cannot express a decrease. Both have
 * `source = reconciliation`, no cash effect and a deterministic dedup hash, so applying the same
 * proposal twice inserts it once.
 */

import { addMicroseconds, type DateTime } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  dividedBy,
  EPOCH,
  exactDecimals,
  type Holding,
  type InstrumentId,
  type PortfolioSnapshot,
  type Transaction,
  type TxnId,
  TxnSource,
  TxnType,
  transaction,
  withDefaults,
} from "../domain/index.js";
import type { ParsedPosition } from "./contract.js";
import { reconciliationHash } from "./dedup.js";

/** Outcome of comparing one instrument's computed quantity with the broker's. */
export const PositionDiffKind = Object.freeze({
  MATCH: "match",
  /** Both sides hold the instrument, with different quantities. */
  MISMATCH: "mismatch",
  /** The broker reports a position the transaction history does not have. */
  MISSING_IN_HISTORY: "missing_in_history",
  /** The history holds a position the broker does not report. */
  MISSING_AT_BROKER: "missing_at_broker",
} as const);
export type PositionDiffKind = (typeof PositionDiffKind)[keyof typeof PositionDiffKind];

/** A broker position line resolved to an instrument (reconciliation input). */
export interface BrokerPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: Decimal;
  readonly currency: Currency;
  readonly asOf: CalendarDate;
  readonly avgPrice: Decimal | null;
  readonly marketValue: Decimal | null;
}

export type BrokerPositionInit = Omit<BrokerPosition, "avgPrice" | "marketValue"> &
  Partial<Pick<BrokerPosition, "avgPrice" | "marketValue">>;

/** `BrokerPosition(...)` with Python's defaults. */
export function brokerPosition(init: BrokerPositionInit): BrokerPosition {
  return withDefaults<BrokerPosition>({ avgPrice: null, marketValue: null }, init);
}

/** `BrokerPosition.from_parsed`. */
export function brokerPositionFromParsed(
  position: ParsedPosition,
  instrumentId: InstrumentId,
): BrokerPosition {
  return brokerPosition({
    instrumentId,
    quantity: position.quantity,
    currency: position.currency,
    asOf: position.asOf,
    avgPrice: position.avgPrice,
    marketValue: position.marketValue,
  });
}

/** Computed vs broker quantity of one instrument in one account. */
export interface PositionDiff {
  readonly instrumentId: InstrumentId;
  /** Quantity derived from transactions (the snapshot holding), 0 when not held. */
  readonly computedQuantity: Decimal;
  /** Quantity in the broker's position export, 0 when not reported. */
  readonly brokerQuantity: Decimal;
  readonly currency: Currency;
  readonly kind: PositionDiffKind;
}

/** `PositionDiff.delta`: `brokerQuantity - computedQuantity`; positive = units missing from history. */
export function positionDelta(diff: PositionDiff): Decimal {
  return exactDecimals(() => diff.brokerQuantity.sub(diff.computedQuantity));
}

/** A transaction that would make the history match the broker for one instrument. */
export interface ProposedCorrection {
  readonly diff: PositionDiff;
  readonly txn: Transaction;
}

export interface ReconciliationReport {
  readonly accountId: AccountId;
  /** Date of the broker positions (the corrections' trade date). */
  readonly asOf: CalendarDate;
  /** Every instrument held or reported: broker order first, then holdings the broker omits. */
  readonly diffs: readonly PositionDiff[];
  readonly corrections: readonly ProposedCorrection[];
  /** Input problems (mixed position dates, snapshot date differs, currency differs...). */
  readonly warnings: readonly string[];
}

/** `ReconciliationReport.mismatches`. */
export function reportMismatches(report: ReconciliationReport): readonly PositionDiff[] {
  return report.diffs.filter((diff) => diff.kind !== PositionDiffKind.MATCH);
}

/** `ReconciliationReport.is_clean`. */
export function reportIsClean(report: ReconciliationReport): boolean {
  return report.corrections.length === 0;
}

export interface ReconcileOptions {
  /** Quantities within this many absolute units match (default 0). */
  readonly tolerance?: Decimal;
  /** Corrections get `createdAt = now + i ms` (default the epoch). */
  readonly now?: DateTime;
  readonly txnIdFactory: () => TxnId;
}

/**
 * Diffs between `snapshot`'s holdings of `accountId` and one complete broker position export of that
 * account, plus proposed corrections. Pure: writes nothing.
 *
 * Build `snapshot` as of the positions' date. Several broker rows of one instrument are summed.
 */
export function reconcile(
  accountId: AccountId,
  positions: readonly BrokerPosition[],
  snapshot: PortfolioSnapshot,
  options: ReconcileOptions,
): ReconciliationReport {
  const tolerance = options.tolerance ?? ZERO;
  const now = options.now ?? EPOCH;
  const warnings: string[] = [];
  const dates = new Set(positions.map((position) => position.asOf));
  // ISO dates: string order is date order
  const asOf = [...dates].sort().at(-1) ?? snapshot.asOf;
  if (dates.size > 1) {
    warnings.push(`Broker positions have ${dates.size} different dates; used ${asOf}`);
  }
  if (snapshot.asOf !== asOf) {
    warnings.push(`Snapshot is as of ${snapshot.asOf} but broker positions as of ${asOf}`);
  }

  const broker = new Map<InstrumentId, BrokerPosition[]>();
  for (const position of positions) {
    const rows = broker.get(position.instrumentId) ?? [];
    rows.push(position);
    broker.set(position.instrumentId, rows);
  }
  const held = new Map<InstrumentId, Holding>();
  for (const holding of snapshot.holdings) {
    if (holding.accountId === accountId) held.set(holding.instrumentId, holding);
  }

  const diffs: PositionDiff[] = [];
  const corrections: ProposedCorrection[] = [];

  const add = (
    instrumentId: InstrumentId,
    computed: Decimal,
    reported: Decimal,
    currency: Currency,
    avgPrice: Decimal | null,
  ): void => {
    const diff: PositionDiff = Object.freeze({
      instrumentId,
      computedQuantity: computed,
      brokerQuantity: reported,
      currency,
      kind: kindOf(computed, reported, tolerance),
    });
    diffs.push(diff);
    if (diff.kind === PositionDiffKind.MATCH) return;
    const createdAt = addMicroseconds(now, corrections.length * 1000);
    const txn = proposal(accountId, asOf, diff, avgPrice, createdAt, options.txnIdFactory());
    corrections.push(Object.freeze({ diff, txn }));
  };

  exactDecimals(() => {
    for (const [instrumentId, rows] of broker) {
      const holding = held.get(instrumentId);
      const [first] = rows;
      if (first === undefined) continue;
      const reported = rows.reduce((total, row) => total.add(row.quantity), ZERO);
      const currency = first.currency;
      if (holding !== undefined && holding.currency !== currency) {
        warnings.push(
          `Currency of ${instrumentId} differs: history ${holding.currency}, broker ${currency}`,
        );
      }
      const computed = holding === undefined ? ZERO : holding.quantity;
      add(instrumentId, computed, reported, currency, averagePrice(rows));
    }
    for (const holding of held.values()) {
      if (!broker.has(holding.instrumentId)) {
        add(holding.instrumentId, holding.quantity, ZERO, holding.currency, null);
      }
    }
  });

  return Object.freeze({
    accountId,
    asOf,
    diffs: Object.freeze(diffs),
    corrections: Object.freeze(corrections),
    warnings: Object.freeze(warnings),
  });
}

function kindOf(computed: Decimal, reported: Decimal, tolerance: Decimal): PositionDiffKind {
  if (reported.sub(computed).abs().lte(tolerance)) return PositionDiffKind.MATCH;
  if (computed.isZero()) return PositionDiffKind.MISSING_IN_HISTORY;
  if (reported.isZero()) return PositionDiffKind.MISSING_AT_BROKER;
  return PositionDiffKind.MISMATCH;
}

/** Quantity-weighted average of the rows' average prices, null when any is unknown. */
function averagePrice(rows: readonly BrokerPosition[]): Decimal | null {
  const [only] = rows;
  if (rows.length === 1 && only !== undefined) return only.avgPrice;
  let cost = ZERO;
  let quantity = ZERO;
  for (const row of rows) {
    if (row.avgPrice === null) return null;
    cost = cost.add(row.avgPrice.mul(row.quantity));
    quantity = quantity.add(row.quantity);
  }
  return quantity.isZero() ? null : dividedBy(cost, quantity);
}

function proposal(
  accountId: AccountId,
  asOf: CalendarDate,
  diff: PositionDiff,
  avgPrice: Decimal | null,
  createdAt: DateTime,
  txnId: TxnId,
): Transaction {
  const delta = positionDelta(diff);
  const increase = delta.gt(ZERO);
  const quantity = delta.abs();
  const txnType = increase ? TxnType.ADJUSTMENT : TxnType.TRANSFER_OUT;
  const price = increase ? avgPrice : null;
  let cost: string;
  if (!increase) cost = "";
  else if (price === null) cost = "; cost unknown";
  else cost = `; cost = broker average price ${price.toString()}`;
  const sign = increase ? "+" : "-";
  return transaction({
    id: txnId,
    accountId,
    type: txnType,
    tradeDate: asOf,
    currency: diff.currency,
    grossAmount: price === null ? ZERO : price.mul(quantity),
    cashAmount: ZERO,
    cashCurrency: diff.currency,
    instrumentId: diff.instrumentId,
    quantity,
    price,
    source: TxnSource.RECONCILIATION,
    note: `Reconciliation: broker reports ${diff.brokerQuantity.toString()}, history gives ${diff.computedQuantity.toString()} (${sign}${quantity.toString()})${cost}`,
    dedupHash: reconciliationHash(accountId, diff.instrumentId, asOf, txnType, quantity),
    createdAt,
  });
}
