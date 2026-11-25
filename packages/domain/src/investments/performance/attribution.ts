/**
 * P/L attribution by instrument and bucket, and profit concentration
 * (`performance/attribution.py`). Pure.
 *
 * Per instrument over a range `(start, end]` (all in the base currency, renamed instruments grouped
 * under their final id): `pnl = end_value - start_value + returned + income - invested - costs`.
 *
 * - `invested`: buys (their cash, fees included) and units moved in (transfer in, adjustment) at that
 *   day's unit value (the same value the contribution series counted);
 * - `returned`: sells (net cash) and units moved out (transfer out) at that day's unit value;
 * - `income`: dividends (net of withholding tax, as booked) and instrument interest;
 * - `costs`: fees and taxes booked on the instrument (and transfer fees);
 * - cash amounts are converted at the rate on/before their date (any age).
 *
 * Account-level items (no instrument): interest, fees, taxes and FX conversions. Concentration:
 * instruments sorted by P/L; `topShares` = the top n P/Ls / the sum of every instrument's P/L (null
 * unless that sum is positive); `pnlWithoutTop2` = the sum without the two largest.
 */

import { type Decimal, sum, ZERO } from "../../decimal.js";
import type { AllocationPlan } from "../domain/buckets.js";
import { TxnType } from "../domain/enums.js";
import type { FxLookup } from "../domain/fx.js";
import type { Instrument } from "../domain/instrument.js";
import type { Transaction } from "../domain/transaction.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  comparePyStr,
  exactDecimals,
  type InstrumentId,
  type TxnId,
} from "../domain/values.js";
import { matchesBucket } from "../portfolio/allocation.js";
import type { Renames } from "./renames.js";
import { cashFlowBase, type HoldingValues } from "./series.js";

export const TOP_N: readonly number[] = Object.freeze([1, 2, 3, 5]);

/** One instrument's P/L parts (mutable while `attribute` sums them). */
export interface InstrumentPnl {
  readonly instrumentId: InstrumentId;
  startValue: Decimal;
  endValue: Decimal;
  invested: Decimal;
  returned: Decimal;
  income: Decimal;
  costs: Decimal;
  /** Held at the range end. */
  held: boolean;
  /** A holding or a cash amount of it could not be valued (its P/L is incomplete). */
  unvalued: boolean;
}

export function instrumentPnl(instrumentId: InstrumentId): InstrumentPnl {
  return {
    instrumentId,
    startValue: ZERO,
    endValue: ZERO,
    invested: ZERO,
    returned: ZERO,
    income: ZERO,
    costs: ZERO,
    held: false,
    unvalued: false,
  };
}

/** `InstrumentPnl.pnl` (in the current decimal context, like the Python property). */
export function pnlOf(r: InstrumentPnl): Decimal {
  return r.endValue.sub(r.startValue).add(r.returned).add(r.income).sub(r.invested).sub(r.costs);
}

export interface AccountLevel {
  interest: Decimal;
  /** Paid, positive. */
  fees: Decimal;
  /** Paid, positive. */
  taxes: Decimal;
  /** Net base value of FX conversion bookings (the conversion cost when negative). */
  fxConversions: Decimal;
  otherIncome: Decimal;
}

export function accountLevel(): AccountLevel {
  return { interest: ZERO, fees: ZERO, taxes: ZERO, fxConversions: ZERO, otherIncome: ZERO };
}

/** `AccountLevel.total`. */
export function accountLevelTotal(level: AccountLevel): Decimal {
  return level.interest
    .sub(level.fees)
    .sub(level.taxes)
    .add(level.fxConversions)
    .add(level.otherIncome);
}

export interface Attribution {
  /** Sorted by P/L, largest first. */
  readonly instruments: readonly InstrumentPnl[];
  readonly accountLevel: AccountLevel;
  /** Cash amounts that could not be converted (no rate). */
  readonly unknownCash: number; // float-ok: a count (Python int)
}

/** `Attribution.instruments_pnl`. */
export function instrumentsPnl(a: Attribution): Decimal {
  return sum(a.instruments.map(pnlOf), ZERO);
}

export interface AttributeInput {
  readonly start: CalendarDate;
  readonly end: CalendarDate;
  /** Holding values at `start` per (account, instrument), null = not valued. */
  readonly startValues: HoldingValues;
  readonly endValues: HoldingValues;
  readonly txnValues: ReadonlyMap<TxnId, Decimal>;
  readonly fx: FxLookup;
  readonly base: Currency;
  readonly renames: Renames;
  readonly accountIds?: ReadonlySet<AccountId> | null;
}

/**
 * P/L per instrument for transactions dated after `start` up to `end` plus the holding values at
 * both ends.
 */
export function attribute(txns: Iterable<Transaction>, input: AttributeInput): Attribution {
  const { start, end, txnValues, fx, base, renames } = input;
  const accountIds = input.accountIds ?? null;
  const rows = new Map<InstrumentId, InstrumentPnl>();
  const level = accountLevel();
  let unknown = 0;

  const row = (instrumentId: InstrumentId): InstrumentPnl => {
    const final = renames.final(instrumentId) ?? instrumentId;
    let r = rows.get(final);
    if (r === undefined) {
      r = instrumentPnl(final);
      rows.set(final, r);
    }
    return r;
  };
  const inScope = (accountId: AccountId): boolean =>
    accountIds === null || accountIds.has(accountId);

  exactDecimals(() => {
    for (const { accountId, instrumentId, value } of input.startValues.values()) {
      if (!inScope(accountId)) continue;
      const r = row(instrumentId);
      if (value === null) r.unvalued = true;
      else r.startValue = r.startValue.add(value);
    }
    for (const { accountId, instrumentId, value } of input.endValues.values()) {
      if (!inScope(accountId)) continue;
      const r = row(instrumentId);
      r.held = true;
      if (value === null) r.unvalued = true;
      else r.endValue = r.endValue.add(value);
    }

    for (const t of txns) {
      if (!(start < t.tradeDate && t.tradeDate <= end) || !inScope(t.accountId)) continue;
      if (t.type === TxnType.DEPOSIT || t.type === TxnType.WITHDRAWAL || t.type === TxnType.SPLIT) {
        continue;
      }
      const movedUnits =
        t.type === TxnType.TRANSFER_IN ||
        t.type === TxnType.TRANSFER_OUT ||
        t.type === TxnType.ADJUSTMENT;
      if (movedUnits && (t.instrumentId === null || t.quantity === null || t.quantity.isZero())) {
        continue; // a cash transfer: an external flow, not P/L
      }
      const cash = cashFlowBase(t, fx, base);
      if (cash === null) {
        unknown += 1;
        if (t.instrumentId !== null) row(t.instrumentId).unvalued = true;
        continue;
      }
      if (t.instrumentId === null) {
        switch (t.type) {
          case TxnType.INTEREST:
            level.interest = level.interest.add(cash);
            break;
          case TxnType.FEE:
            level.fees = level.fees.sub(cash);
            break;
          case TxnType.TAX:
            level.taxes = level.taxes.sub(cash);
            break;
          case TxnType.FX_CONVERSION:
            level.fxConversions = level.fxConversions.add(cash);
            break;
          default:
            level.otherIncome = level.otherIncome.add(cash);
        }
        continue;
      }
      const r = row(t.instrumentId);
      switch (t.type) {
        case TxnType.BUY:
          r.invested = r.invested.sub(cash);
          break;
        case TxnType.SELL:
          r.returned = r.returned.add(cash);
          break;
        case TxnType.DIVIDEND:
        case TxnType.INTEREST:
          r.income = r.income.add(cash);
          break;
        case TxnType.FEE:
        case TxnType.TAX:
          r.costs = r.costs.sub(cash);
          break;
        case TxnType.TRANSFER_IN:
        case TxnType.ADJUSTMENT: {
          r.costs = r.costs.sub(cash);
          const moved = txnValues.get(t.id);
          if (moved === undefined) r.unvalued = true;
          else r.invested = r.invested.add(moved);
          break;
        }
        case TxnType.TRANSFER_OUT: {
          r.costs = r.costs.sub(cash);
          const moved = txnValues.get(t.id);
          if (moved === undefined) r.unvalued = true;
          else r.returned = r.returned.add(moved);
          break;
        }
        default:
          r.income = r.income.add(cash);
      }
    }
  });

  // Python sorts by (-pnl, instrument_id) outside the exact context: pnl in the current context
  const keyed = [...rows.values()].map((r) => [pnlOf(r), r] as const);
  keyed.sort((a, b) => {
    const c = b[0].compare(a[0]);
    return c !== 0 ? c : comparePyStr(a[1].instrumentId, b[1].instrumentId);
  });
  return Object.freeze({
    instruments: keyed.map(([, r]) => r),
    accountLevel: level,
    unknownCash: unknown,
  });
}

/**
 * The strategy bucket (first match in declaration order), `unclassified` when none matches; without
 * buckets the asset class.
 */
export function bucketOf(instrument: Instrument | null, plan: AllocationPlan | null): string {
  if (instrument === null) return "unclassified";
  if (plan === null || plan.buckets.length === 0) return instrument.assetClass;
  for (const bucket of plan.buckets) {
    if (matchesBucket(bucket.match, instrument)) return bucket.id;
  }
  return "unclassified";
}

export interface Concentration {
  /** Sum of every instrument's P/L. */
  readonly total: Decimal;
  /** [n, share of the total P/L held by the top n]. */
  readonly topShares: readonly (readonly [number, number | null])[];
  readonly top2: readonly InstrumentId[];
  readonly pnlWithoutTop2: Decimal;
  readonly positive: number;
  readonly negative: number;
}

export function concentration(pnls: readonly (readonly [InstrumentId, Decimal])[]): Concentration {
  const ordered = [...pnls].sort((a, b) => {
    const c = b[1].compare(a[1]);
    return c !== 0 ? c : comparePyStr(a[0], b[0]);
  });
  const total = sum(
    ordered.map(([, p]) => p),
    ZERO,
  );
  const shares: [number, number | null][] = [];
  for (const n of TOP_N) {
    const top = sum(
      ordered.slice(0, n).map(([, p]) => p),
      ZERO,
    );
    shares.push([n, total.gt(ZERO) && ordered.length >= 1 ? top.div(total).toFloat() : null]);
  }
  const top2 = ordered.slice(0, 2).map(([i]) => i);
  const without = total.sub(
    sum(
      ordered.slice(0, 2).map(([, p]) => p),
      ZERO,
    ),
  );
  return Object.freeze({
    total,
    topShares: shares,
    top2,
    pnlWithoutTop2: without,
    positive: ordered.filter(([, p]) => p.gt(ZERO)).length,
    negative: ordered.filter(([, p]) => p.lt(ZERO)).length,
  });
}

/** [bucket, P/L, instruments] sorted by P/L, largest first (ties by bucket). */
export function groupByBucket(
  rows: readonly InstrumentPnl[],
  bucket: (instrumentId: InstrumentId) => string,
): [string, Decimal, number][] {
  const totals = new Map<string, [Decimal, number]>();
  for (const r of rows) {
    const key = bucket(r.instrumentId);
    const entry = totals.get(key) ?? [ZERO, 0];
    totals.set(key, [entry[0].add(pnlOf(r)), entry[1] + 1]);
  }
  return [...totals.entries()]
    .map(([k, [p, n]]): [string, Decimal, number] => [k, p, n])
    .sort((a, b) => {
      const c = b[1].compare(a[1]);
      return c !== 0 ? c : comparePyStr(a[0], b[0]);
    });
}
