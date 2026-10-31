/**
 * Daily portfolio value and external-flow series per account in the base currency
 * (`performance/series.py`). Pure, no I/O.
 *
 * One incremental pass of the FIFO lot engine gives the snapshot at the end of every day with
 * transactions (`SnapshotStream`). Each calendar day is then valued with the shared `valuePortfolio`
 * (the overview's rules: bar on/before the day of any age, stale but valued; last trade price
 * fallback; cost, manual and frozen modes; cash floored at 0; FX older than `maxFxAgeDays` left out)
 * over a market view holding one bar per held instrument, its close brought to the units held that
 * day (`PriceAdjuster`).
 *
 * External flows (+ = money put in): deposits and withdrawals, cash-only transfers, units moved in or
 * out (`transfer_in` / `adjustment` / `transfer_out`) at that day's unit value, and implied funding:
 * when a cash balance goes (more) negative, the valuation counts it as 0, so the shortfall is money
 * that came from outside the recorded history.
 */

import { addDays, daysBetween } from "../../dates.js";
import { Decimal, ZERO } from "../../decimal.js";
import { TxnType, ValuationMode } from "../domain/enums.js";
import { DEFAULT_MAX_FX_AGE_DAYS, type FxLookup } from "../domain/fx.js";
import type { Instrument, InstrumentRename, ManualValuation } from "../domain/instrument.js";
import type { PriceBar } from "../domain/marketData.js";
import {
  countedBase,
  type DatedPrice,
  marketView,
  type PortfolioSnapshot,
  portfolioSnapshot,
} from "../domain/snapshot.js";
import { compareChronological, type Transaction } from "../domain/transaction.js";
import type { CalendarDate } from "../domain/values.js";
import {
  type AccountId,
  asProfileId,
  type Currency,
  exactDecimals,
  type InstrumentId,
  type TxnId,
} from "../domain/values.js";
import { lastTradePrices } from "../portfolio/lastTradePrices.js";
import { effectiveValuationMode, valuePortfolio } from "../portfolio/valuation.js";
import { PriceAdjuster, type PriceMismatch, type PriceScale } from "./priceAdjuster.js";
import { Renames } from "./renames.js";
import { bisectRight } from "./search.js";
import { SnapshotStream } from "./snapshotStream.js";

/** The strategy's data limits the valuation applies (`data:`). */
export interface ValuationPolicy {
  readonly maxPriceAgeDays: number; // float-ok: a day count (Python int)
  readonly maxFxAgeDays: number;
}

/** `ValuationPolicy()` defaults. */
export const DEFAULT_VALUATION_POLICY: ValuationPolicy = Object.freeze({
  maxPriceAgeDays: 5,
  maxFxAgeDays: DEFAULT_MAX_FX_AGE_DAYS,
});

/** One account's daily series, aligned with `PortfolioSeries.dates`. */
export interface AccountSeries {
  readonly accountId: AccountId;
  /** End-of-day value (holdings + counted cash); partial when the day is incomplete. */
  readonly values: Decimal[];
  /** External flows of the day, + = money put in. */
  readonly flows: Decimal[];
  /** Account-level fees and taxes of the day (no instrument), + = paid. */
  readonly fees: Decimal[];
  readonly complete: boolean[];
  /** The implied-funding part of `flows`. */
  readonly implied: Decimal[];
}

/** Accounts summed: floats ready for the return math. */
export interface Combined {
  readonly values: readonly number[];
  readonly flows: readonly number[];
  readonly fees: readonly number[]; // float-ok: Python float fees
  readonly complete: readonly boolean[];
  readonly implied: readonly number[];
}

/** A holding value at a capture date (null = not valued). */
export interface HoldingValue {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly value: Decimal | null;
}

/** Holding values per (account, instrument), in the valuation's order (`holdingKey`). */
export type HoldingValues = ReadonlyMap<string, HoldingValue>;

/** Key of a (account, instrument) pair in `HoldingValues`. */
export function holdingKey(accountId: AccountId, instrumentId: InstrumentId): string {
  return `${accountId}\u0000${instrumentId}`;
}

/** Output of `buildSeries`. */
export interface PortfolioSeries {
  readonly base: Currency;
  /** Every calendar day from the day before the first transaction (value 0) to `end`. */
  readonly dates: readonly CalendarDate[];
  readonly accounts: ReadonlyMap<AccountId, AccountSeries>;
  /** Holding values per (account, instrument) at the requested capture dates. */
  readonly captures: ReadonlyMap<CalendarDate, HoldingValues>;
  /** Base value of the units moved by transfers and adjustments (what the flow counted). */
  readonly txnValues: ReadonlyMap<TxnId, Decimal>;
  /** Transactions whose flow could not be valued (no rate, no price): counted as 0. */
  readonly unknownFlows: readonly TxnId[];
  readonly priceScales: readonly PriceScale[];
  readonly priceMismatches: readonly PriceMismatch[];
  readonly lastBarDates: ReadonlyMap<InstrumentId, CalendarDate>;
}

/** `PortfolioSeries.first_date`. */
export function seriesFirstDate(series: PortfolioSeries): CalendarDate | null {
  return series.dates.length > 1 ? (series.dates[1] as CalendarDate) : null;
}

/** `PortfolioSeries.index_of`: position of `day`, clamped to the series. */
export function seriesIndexOf(series: PortfolioSeries, day: CalendarDate): number {
  const first = series.dates[0];
  if (first === undefined) throw new RangeError("empty series");
  return Math.max(0, Math.min(series.dates.length - 1, daysBetween(first, day)));
}

/**
 * `PortfolioSeries.combined`: the sum of the accounts in `accountIds` (all when null); a day is
 * complete when every selected account is.
 */
export function combineSeries(
  series: PortfolioSeries,
  accountIds: ReadonlySet<AccountId> | null = null,
): Combined {
  const n = series.dates.length;
  const values = new Array<number>(n).fill(0.0);
  const flows = new Array<number>(n).fill(0.0);
  const fees = new Array<number>(n).fill(0.0);
  const implied = new Array<number>(n).fill(0.0);
  const complete = new Array<boolean>(n).fill(true);
  for (const [accountId, s] of series.accounts) {
    if (accountIds !== null && !accountIds.has(accountId)) continue;
    for (let i = 0; i < n; i++) {
      values[i] = (values[i] as number) + (s.values[i] as Decimal).toFloat();
      flows[i] = (flows[i] as number) + (s.flows[i] as Decimal).toFloat();
      fees[i] = (fees[i] as number) + (s.fees[i] as Decimal).toFloat();
      implied[i] = (implied[i] as number) + (s.implied[i] as Decimal).toFloat();
      complete[i] = (complete[i] as boolean) && (s.complete[i] as boolean);
    }
  }
  return Object.freeze({ values, flows, fees, complete, implied });
}

export interface BuildSeriesInput {
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  /** Stored closes (any instruments; held ones are used), oldest first. */
  readonly bars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
  /** Must know the rates of every currency involved (any base: cross rates through the pivot). */
  readonly fx: FxLookup;
  readonly base: Currency;
  readonly end: CalendarDate;
  readonly renames?: readonly InstrumentRename[];
  readonly manualValuations?: ReadonlyMap<InstrumentId, readonly ManualValuation[]> | null;
  readonly policy?: ValuationPolicy | null;
  /** Days whose per-holding values are kept (attribution). */
  readonly captureDates?: Iterable<CalendarDate>;
}

/** Python `_natural`: digit ids by their number first, then other ids by text. */
function compareNatural(a: string, b: string): number {
  const da = /^[0-9]+$/.test(a);
  const db = /^[0-9]+$/.test(b);
  if (da !== db) return da ? -1 : 1;
  if (da) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sentinel of `external`: the transaction is no external flow. */
const NOT_EXTERNAL = Symbol("not external");

type ToBase = (amount: Decimal, currency: Currency, on: CalendarDate) => Decimal | null;

/**
 * Daily values and flows of every account from the day before the first transaction to `end`
 * (inputs on `BuildSeriesInput`).
 */
export function buildSeries(txns: Iterable<Transaction>, input: BuildSeriesInput): PortfolioSeries {
  const { instruments, bars, fx, base, end } = input;
  const renames = input.renames ?? [];
  const policy = input.policy ?? DEFAULT_VALUATION_POLICY;
  const ordered = [...txns].filter((t) => t.tradeDate <= end).sort(compareChronological);
  const manual = new Map<InstrumentId, readonly ManualValuation[]>();
  for (const [id, list] of input.manualValuations ?? []) manual.set(id, [...list]);
  const first = ordered[0];
  if (first === undefined) {
    return emptySeries(base, end);
  }
  const renamesBy = new Renames(renames);
  const activeRenames = renames.filter((r) => r.date <= end);
  const adjuster = new PriceAdjuster(ordered, renamesBy, bars, instruments);
  const anchor = addDays(first.tradeDate, -1);
  const dates: CalendarDate[] = [];
  const span = daysBetween(anchor, end);
  for (let i = 0; i <= span; i++) dates.push(addDays(anchor, i));
  const accountIds = [...new Set(ordered.map((t) => t.accountId))].sort(compareNatural);
  const accounts = new Map<AccountId, AccountSeries>();
  for (const a of accountIds) {
    accounts.set(a, { accountId: a, values: [], flows: [], fees: [], complete: [], implied: [] });
  }
  const captures = new Map<CalendarDate, HoldingValues>();
  const wantedCaptures = new Set(input.captureDates ?? []);
  const txnValues = new Map<TxnId, Decimal>();
  const unknown: TxnId[] = [];

  const keepLots = (instrumentId: InstrumentId): boolean => {
    const inst = instruments.get(instrumentId);
    return inst === undefined || effectiveValuationMode(inst) === ValuationMode.COST;
  };

  const stream = new SnapshotStream(ordered, activeRenames, keepLots);
  const txnsByDate = new Map<CalendarDate, Transaction[]>();
  for (const t of ordered) {
    const list = txnsByDate.get(t.tradeDate);
    if (list === undefined) txnsByDate.set(t.tradeDate, [t]);
    else list.push(t);
  }
  const tradeDates = ordered.map((t) => t.tradeDate);

  let snapshot: PortfolioSnapshot = portfolioSnapshot({ profileId: asProfileId(""), asOf: anchor });
  let ltp: ReadonlyMap<InstrumentId, DatedPrice> | null = null;
  let prevCash = new Map<string, { accountId: AccountId; currency: Currency; amount: Decimal }>();
  const lastUnit = new Map<InstrumentId, Decimal>();

  const toBase: ToBase = (amount, currency, on) => {
    if (amount.isZero()) return ZERO;
    const quote = fx.quoteOnOrBefore(currency, on, base);
    return quote === null ? null : amount.mul(quote.rate);
  };

  exactDecimals(() => {
    for (const day of dates) {
      if (stream.advance(day)) {
        snapshot = stream.snapshot;
        ltp = null;
      }

      const barsToday = new Map<InstrumentId, readonly PriceBar[]>();
      let needsFallback = false;
      for (const h of snapshot.holdings) {
        const iid = h.instrumentId;
        if (barsToday.has(iid)) continue;
        const bar = adjuster.barOn(iid, day);
        if (bar !== null) barsToday.set(iid, [bar]);
        else needsFallback = true;
      }
      if (needsFallback && ltp === null) {
        const upto = bisectRight(tradeDates, day);
        ltp = lastTradePrices(ordered.slice(0, upto), {
          asOf: day,
          renames: activeRenames.filter((r) => r.date <= day),
        });
      }
      const view = marketView({
        asOf: day,
        instruments,
        bars: barsToday,
        manualValuations: manual,
      });
      const valued = valuePortfolio(
        portfolioSnapshot({
          profileId: asProfileId(""),
          asOf: day,
          holdings: snapshot.holdings,
          cash: snapshot.cash,
          lastTradePrices: ltp ?? new Map(),
        }),
        view,
        fx,
        base,
        policy.maxPriceAgeDays,
        { maxFxAgeDays: policy.maxFxAgeDays },
      );

      const value = new Map<AccountId, Decimal>(accountIds.map((a) => [a, ZERO]));
      const flow = new Map<AccountId, Decimal>(accountIds.map((a) => [a, ZERO]));
      const fees = new Map<AccountId, Decimal>(accountIds.map((a) => [a, ZERO]));
      const implied = new Map<AccountId, Decimal>(accountIds.map((a) => [a, ZERO]));
      const whole = new Map<AccountId, boolean>(accountIds.map((a) => [a, true]));
      const add = (m: Map<AccountId, Decimal>, a: AccountId, x: Decimal) =>
        m.set(a, (m.get(a) ?? ZERO).add(x));
      const unitToday = new Map<InstrumentId, Decimal>();
      const capture = wantedCaptures.has(day);
      const captured = new Map<string, HoldingValue>();
      for (const vh of valued.valued) {
        const mv = vh.marketValueBase;
        if (capture) {
          captured.set(holdingKey(vh.holding.accountId, vh.holding.instrumentId), {
            accountId: vh.holding.accountId,
            instrumentId: vh.holding.instrumentId,
            value: mv,
          });
        }
        if (mv === null) {
          whole.set(vh.holding.accountId, false);
          continue;
        }
        add(value, vh.holding.accountId, mv);
        if (vh.holding.quantity.gt(ZERO)) {
          unitToday.set(vh.holding.instrumentId, mv.div(vh.holding.quantity));
        }
      }
      for (const vc of valued.cash) {
        if (vc.amountBase === null) whole.set(vc.cash.accountId, false);
        add(value, vc.cash.accountId, countedBase(vc));
      }
      if (capture) captures.set(day, captured);

      /**
       * Base value of one unit on `day`: the day's valuation per unit, else (the units left the
       * portfolio) the day's close, else the last valuation per unit.
       */
      const dayUnit = (iid: InstrumentId): Decimal | null => {
        const today = unitToday.get(iid);
        if (today !== undefined) return today;
        const inst = instruments.get(iid);
        if (inst !== undefined && effectiveValuationMode(inst) === ValuationMode.MARKET) {
          const bar = adjuster.barOn(iid, day);
          if (bar !== null) {
            const quote = fx.quoteOnOrBefore(bar.currency ?? inst.currency, day, base);
            if (quote !== null) return bar.close.mul(quote.rate);
          }
        }
        return lastUnit.get(iid) ?? null;
      };

      for (const t of txnsByDate.get(day) ?? []) {
        const moved = external(t, day, renamesBy, dayUnit, toBase);
        if (moved === NOT_EXTERNAL) {
          if ((t.type === TxnType.FEE || t.type === TxnType.TAX) && t.instrumentId === null) {
            const paid = toBase(t.cashAmount.neg(), t.cashCurrency, day);
            if (paid !== null) add(fees, t.accountId, paid);
          }
          continue;
        }
        const [amount, unitValue] = moved;
        if (amount === null) {
          unknown.push(t.id);
          whole.set(t.accountId, false);
          continue;
        }
        add(flow, t.accountId, amount);
        if (unitValue !== null) txnValues.set(t.id, amount.abs());
      }

      const cashNow = new Map<
        string,
        { accountId: AccountId; currency: Currency; amount: Decimal }
      >();
      for (const c of snapshot.cash) {
        cashNow.set(`${c.accountId}\u0000${c.currency}`, {
          accountId: c.accountId,
          currency: c.currency,
          amount: c.amount,
        });
      }
      // Python iterates a set of the keys; the order only changes exact Decimal additions
      const keys = new Map([...prevCash, ...cashNow]);
      for (const [key, entry] of keys) {
        const before = maxZero((prevCash.get(key)?.amount ?? ZERO).neg());
        const after = maxZero((cashNow.get(key)?.amount ?? ZERO).neg());
        if (before.eq(after)) continue;
        const gap = toBase(after.sub(before), entry.currency, day);
        if (gap === null) {
          whole.set(entry.accountId, false);
          continue;
        }
        add(flow, entry.accountId, gap);
        add(implied, entry.accountId, gap);
      }
      prevCash = cashNow;
      for (const [iid, unit] of unitToday) lastUnit.set(iid, unit);

      for (const a of accountIds) {
        const s = accounts.get(a) as AccountSeries;
        s.values.push(value.get(a) as Decimal);
        s.flows.push(flow.get(a) as Decimal);
        s.fees.push(fees.get(a) as Decimal);
        s.complete.push(whole.get(a) as boolean);
        s.implied.push(implied.get(a) as Decimal);
      }
    }
  });

  const lastBars = new Map<InstrumentId, CalendarDate>();
  for (const iid of instruments.keys()) {
    const d = adjuster.lastBarDate(iid);
    if (d !== null) lastBars.set(iid, d);
  }
  return Object.freeze({
    base,
    dates,
    accounts,
    captures,
    txnValues,
    unknownFlows: unknown,
    priceScales: adjuster.scales,
    priceMismatches: adjuster.mismatches,
    lastBarDates: lastBars,
  });
}

/** The series of a profile without transactions: `end` only, no accounts. */
export function emptySeries(base: Currency, end: CalendarDate): PortfolioSeries {
  return Object.freeze({
    base,
    dates: [end],
    accounts: new Map(),
    captures: new Map(),
    txnValues: new Map(),
    unknownFlows: [],
    priceScales: [],
    priceMismatches: [],
    lastBarDates: new Map(),
  });
}

/** Python `max(ZERO, x)`: `x` when it is above zero, else `ZERO`. */
function maxZero(x: Decimal): Decimal {
  return x.gt(ZERO) ? x : ZERO;
}

/**
 * `[amount, unitValue]` of an external flow (amount null = could not be valued), or `NOT_EXTERNAL`.
 */
function external(
  t: Transaction,
  day: CalendarDate,
  renames: Renames,
  unitValue: (iid: InstrumentId) => Decimal | null,
  toBase: ToBase,
): readonly [Decimal | null, Decimal | null] | typeof NOT_EXTERNAL {
  if (t.type === TxnType.DEPOSIT || t.type === TxnType.WITHDRAWAL) {
    return [toBase(t.cashAmount, t.cashCurrency, day), null];
  }
  if (
    t.type !== TxnType.TRANSFER_IN &&
    t.type !== TxnType.TRANSFER_OUT &&
    t.type !== TxnType.ADJUSTMENT
  ) {
    return NOT_EXTERNAL;
  }
  if (t.instrumentId === null || t.quantity === null || t.quantity.isZero()) {
    // A cash transfer between the account and the outside.
    return [toBase(t.cashAmount, t.cashCurrency, day), null];
  }
  const resolved = renames.resolve(t.instrumentId, day);
  let unit = resolved === null ? null : unitValue(resolved);
  if (unit === null && t.price !== null && !t.price.isZero() && t.price.gt(ZERO)) {
    unit = toBase(t.price, t.currency, day);
  }
  if (unit === null) return [null, null];
  const sign = Decimal.fromInt(t.type === TxnType.TRANSFER_OUT ? -1 : 1);
  return [sign.mul(t.quantity).mul(unit), unit];
}

/** A transaction's cash amount in the base currency at the rate on/before its date (any age). */
export function cashFlowBase(t: Transaction, fx: FxLookup, base: Currency): Decimal | null {
  if (t.cashAmount.isZero()) return ZERO;
  const quote = fx.quoteOnOrBefore(t.cashCurrency, t.tradeDate, base);
  if (quote === null) return null;
  return exactDecimals(() => t.cashAmount.mul(quote.rate));
}
