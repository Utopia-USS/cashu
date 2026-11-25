/**
 * What moved the portfolio over a short window, by market segment, and how much was currency (P5),
 * plus the topic trends (P7) (`performance/segment_attribution.py`). Pure: the service hands in the
 * start holdings, the bars and the rates.
 *
 * Method (holdings-based, as documented on the Python module):
 *
 * - Holdings are the quantities at `start`; `T0` = the full portfolio value at `start` in the base
 *   currency (cash and cost / manually valued holdings included).
 * - For each market-valued holding at `start`: `V0` = its base value, `rL` = the local price return
 *   (close on/before `start` -> close on/before `end`; a close older than `maxPriceAgeDays` is still
 *   used but flagged in `stale`; no close = 0 and flagged), `rF` = the return of its price currency
 *   against the base (0 for the base currency or a missing rate), `rB = (1 + rL)(1 + rF) - 1`; its
 *   segment's contribution += `V0 * rL / T0`, the currency contribution += `V0 * (rB - rL) / T0`.
 * - Holdings without a segment form the `unassigned` row; cost / manually valued holdings contribute 0
 *   but keep their weight. `explained` = every segment row + currency. `T0 <= 0` gives an empty result.
 * - Snapshot-held positions (P7): `snapshotOpenings` dates an account's first-snapshot opening at
 *   `start` when it is later, so the position counts as held at `start`.
 */

import { addDays } from "../../dates.js";
import { type Decimal, ONE, sum, ZERO } from "../../decimal.js";
import { TxnSource, TxnType } from "../domain/enums.js";
import type { FxLookup } from "../domain/fx.js";
import type { PriceBar } from "../domain/marketData.js";
import { compareChronological, type Transaction, transaction } from "../domain/transaction.js";
import type { CalendarDate } from "../domain/values.js";
import {
  type Currency,
  comparePyStr,
  daysBetween,
  exactDecimals,
  type InstrumentId,
  type TxnId,
} from "../domain/values.js";
import { pySum } from "./floats.js";
import { bisectRight } from "./search.js";

export const DEFAULT_MAX_PRICE_AGE_DAYS = 5;

/** One holding at `start` (several accounts holding one instrument may be given apart; summed). */
export interface StartHolding {
  readonly instrumentId: InstrumentId;
  /** The price currency of its bars (the instrument currency). */
  readonly currency: Currency;
  /** `V0`: the value at `start` in the base currency. */
  readonly valueBase: Decimal | null;
  /** Valued from market prices; false for cost / manual valuation (weight only, contributes 0). */
  readonly market: boolean;
  /** Valued from data older than the valuation allows (listed in `stale`). */
  readonly stale: boolean;
}

export function startHolding(
  init: Omit<StartHolding, "market" | "stale"> & { market?: boolean; stale?: boolean },
): StartHolding {
  return Object.freeze({ market: true, stale: false, ...init });
}

export interface StartPortfolio {
  /** `T0`: the full portfolio value at `start` in the base currency (cash included). */
  readonly totalBase: Decimal;
  readonly holdings: readonly StartHolding[];
  /** Held at `start` without any value there: left out of `T0` and the rows, listed in `stale`. */
  readonly unvalued: readonly InstrumentId[];
  /** Every instrument held at `start` (cash-like ones included); what `newPositions` compares. */
  readonly held: readonly InstrumentId[];
}

export function startPortfolio(
  init: Pick<StartPortfolio, "totalBase"> & Partial<Omit<StartPortfolio, "totalBase">>,
): StartPortfolio {
  return Object.freeze({ holdings: [], unvalued: [], held: [], ...init });
}

export interface InstrumentMove {
  readonly instrumentId: InstrumentId;
  readonly weight: number;
  readonly contribution: number;
  /** null for a cost / manually valued holding (no market return). */
  readonly ret: number | null;
}

export interface SegmentMove {
  /** The segment key; null for the unassigned row. */
  readonly segment: string | null;
  readonly weight: number;
  readonly contribution: number;
  readonly ret: number | null;
  readonly instruments: readonly InstrumentMove[];
}

export interface CurrencyMove {
  readonly currency: string;
  readonly weight: number;
  readonly ret: number;
  readonly contribution: number;
}

export interface SegmentAttribution {
  readonly start: CalendarDate;
  readonly end: CalendarDate;
  /** Rows with a segment, by |contribution| (ties by key). */
  readonly segments: readonly SegmentMove[];
  readonly unassigned: SegmentMove | null;
  readonly currencyContribution: number;
  /** Foreign price currencies (the base currency is left out: its return is 0). */
  readonly currencies: readonly CurrencyMove[];
  readonly explained: number;
  readonly newPositions: number;
  /** Instruments with a stale or missing close at `start` / `end`, or without any value at `start`. */
  readonly stale: readonly InstrumentId[];
}

/** `SegmentAttribution.empty`. */
export function isEmptyAttribution(a: SegmentAttribution): boolean {
  return a.segments.length === 0 && a.unassigned === null;
}

/**
 * `txns` with each snapshot opening dated `start` when it is later: per (account, instrument), when
 * the first transaction is a reconciliation `adjustment` dated after `start` and on the account's
 * earliest reconciliation day (its first snapshot). Every other transaction is returned unchanged.
 */
export function snapshotOpenings(txns: readonly Transaction[], start: CalendarDate): Transaction[] {
  const first = new Map<string, Transaction>();
  const firstSnapshot = new Map<string, CalendarDate>();
  for (const t of [...txns].sort(compareChronological)) {
    if (t.source === TxnSource.RECONCILIATION && !firstSnapshot.has(t.accountId)) {
      firstSnapshot.set(t.accountId, t.tradeDate);
    }
    if (t.instrumentId !== null) {
      const key = `${t.accountId}\u0000${t.instrumentId}`;
      if (!first.has(key)) first.set(key, t);
    }
  }
  const moved = new Set<TxnId>();
  for (const t of first.values()) {
    if (
      t.source === TxnSource.RECONCILIATION &&
      t.type === TxnType.ADJUSTMENT &&
      t.tradeDate > start &&
      t.tradeDate === firstSnapshot.get(t.accountId)
    ) {
      moved.add(t.id);
    }
  }
  if (moved.size === 0) return [...txns];
  return txns.map((t) =>
    moved.has(t.id) ? transaction({ ...t, tradeDate: start, settleDate: null }) : t,
  );
}

/** The newest bar dated on/before `day` (`bars` oldest first). */
export function closeOnOrBefore(bars: readonly PriceBar[], day: CalendarDate): PriceBar | null {
  const i = bisectRight(
    bars.map((b) => b.date),
    day,
  );
  return i > 0 ? (bars[i - 1] as PriceBar) : null;
}

function fxReturn(
  fx: FxLookup,
  currency: Currency,
  base: Currency,
  start: CalendarDate,
  end: CalendarDate,
): Decimal {
  if (currency === base) return ZERO;
  const then = fx.quoteOnOrBefore(currency, start, base);
  const now = fx.quoteOnOrBefore(currency, end, base);
  if (then === null || now === null || then.rate.lte(ZERO)) return ZERO;
  return now.rate.div(then.rate).sub(ONE);
}

/** `float(part / total) + 0.0` (never -0.0). */
function ratioOf(part: Decimal, total: Decimal): number {
  return part.div(total).toFloat() + 0.0;
}

/** [instrument, V0, local return; null = not market-valued]. */
type Item = readonly [InstrumentId, Decimal, Decimal | null];

export interface AttributeSegmentsOptions {
  /** Instruments held at `end` (those not held at `start` count as `newPositions`). */
  readonly heldAtEnd?: Iterable<InstrumentId>;
  readonly maxPriceAgeDays?: number; // float-ok: a day count (Python int)
}

const byNegAbs = (a: number, b: number): number => -Math.abs(a) - -Math.abs(b);

/** The segment / currency attribution of `holdingsT0` over `start` -> `end` (module doc). */
export function attributeSegments(
  holdingsT0: StartPortfolio,
  prices: ReadonlyMap<InstrumentId, readonly PriceBar[]>,
  fx: FxLookup,
  base: Currency,
  start: CalendarDate,
  end: CalendarDate,
  segmentOf: (instrumentId: InstrumentId) => string | null,
  options: AttributeSegmentsOptions = {},
): SegmentAttribution {
  return exactDecimals(() => {
    const maxPriceAgeDays = options.maxPriceAgeDays ?? DEFAULT_MAX_PRICE_AGE_DAYS;
    const atStart = new Set<InstrumentId>([
      ...holdingsT0.held,
      ...holdingsT0.holdings.map((h) => h.instrumentId),
      ...holdingsT0.unvalued,
    ]);
    const newPositions = new Set([...(options.heldAtEnd ?? [])].filter((i) => !atStart.has(i)))
      .size;
    const stale = new Set<InstrumentId>(holdingsT0.unvalued);
    const total = holdingsT0.totalBase;
    if (total.lte(ZERO)) {
      return freezeResult({
        start,
        end,
        segments: [],
        unassigned: null,
        currencyContribution: 0.0,
        currencies: [],
        explained: 0.0,
        newPositions,
        stale: [...stale].sort(comparePyStr),
      });
    }

    const values = new Map<InstrumentId, Decimal>();
    const currencyOf = new Map<InstrumentId, Currency>();
    const market = new Map<InstrumentId, boolean>();
    for (const h of holdingsT0.holdings) {
      if (h.valueBase === null || h.valueBase.lte(ZERO)) continue;
      values.set(h.instrumentId, (values.get(h.instrumentId) ?? ZERO).add(h.valueBase));
      currencyOf.set(h.instrumentId, h.currency);
      market.set(h.instrumentId, (market.get(h.instrumentId) ?? false) || h.market);
      if (h.stale) stale.add(h.instrumentId);
    }

    // keyed by the segment; the unassigned row under `null`
    const rows = new Map<string | null, Item[]>();
    const push = (key: string | null, item: Item) => {
      const list = rows.get(key);
      if (list === undefined) rows.set(key, [item]);
      else list.push(item);
    };
    const byCurrency = new Map<string, [Decimal, Decimal, Decimal]>(); // [V0 sum, contribution, rF]
    let currencyTotal = ZERO;
    for (const [iid, v0] of values) {
      if (!market.get(iid)) {
        push(segmentOf(iid), [iid, v0, null]);
        continue;
      }
      const series = prices.get(iid) ?? [];
      const first = closeOnOrBefore(series, start);
      const last = closeOnOrBefore(series, end);
      const flagged =
        first === null ||
        last === null ||
        daysBetween(first.date, start) > maxPriceAgeDays ||
        daysBetween(last.date, end) > maxPriceAgeDays;
      if (flagged) stale.add(iid);
      const local =
        first !== null && last !== null && first.close.gt(ZERO)
          ? last.close.div(first.close).sub(ONE)
          : ZERO;
      const currency = currencyOf.get(iid) as Currency;
      const fxRet = fxReturn(fx, currency, base, start, end);
      const totalRet = ONE.add(local).mul(ONE.add(fxRet)).sub(ONE);
      push(segmentOf(iid), [iid, v0, local]);
      const fxPart = v0.mul(totalRet.sub(local));
      currencyTotal = currencyTotal.add(fxPart);
      if (currency !== base) {
        const entry = byCurrency.get(currency) ?? [ZERO, ZERO, fxRet];
        byCurrency.set(currency, [entry[0].add(v0), entry[1].add(fxPart), entry[2]]);
      }
    }

    const move = (segment: string | null, items: readonly Item[]): SegmentMove => {
      const v0 = sum(
        items.map(([, v]) => v),
        ZERO,
      );
      const priced = items.filter(
        (it): it is readonly [InstrumentId, Decimal, Decimal] => it[2] !== null,
      );
      const pricedV0 = sum(
        priced.map(([, v]) => v),
        ZERO,
      );
      const gain = sum(
        priced.map(([, v, r]) => v.mul(r)),
        ZERO,
      );
      const instruments = items
        .map(
          ([iid, v, r]): InstrumentMove =>
            Object.freeze({
              instrumentId: iid,
              weight: ratioOf(v, total),
              contribution: r !== null ? ratioOf(v.mul(r), total) : 0.0,
              ret: r !== null ? r.toFloat() + 0.0 : null,
            }),
        )
        .sort(
          (a, b) =>
            byNegAbs(a.contribution, b.contribution) ||
            Number(a.ret === null) - Number(b.ret === null) ||
            comparePyStr(a.instrumentId, b.instrumentId),
        );
      return Object.freeze({
        segment,
        weight: ratioOf(v0, total),
        contribution: ratioOf(gain, total),
        ret: pricedV0.gt(ZERO) ? gain.div(pricedV0).toFloat() + 0.0 : null,
        instruments,
      });
    };

    const segments = [...rows.entries()]
      .filter(([key]) => key !== null)
      .map(([key, items]) => move(key, items))
      .sort(
        (a, b) =>
          byNegAbs(a.contribution, b.contribution) ||
          comparePyStr(a.segment ?? "", b.segment ?? ""),
      );
    const unassignedItems = rows.get(null);
    const unassigned = unassignedItems === undefined ? null : move(null, unassignedItems);
    let explainedSum = ZERO;
    for (const items of rows.values()) {
      for (const [, v, r] of items) if (r !== null) explainedSum = explainedSum.add(v.mul(r));
    }
    const explained = explainedSum.add(currencyTotal);
    const currencies = [...byCurrency.entries()]
      .map(
        ([code, entry]): CurrencyMove =>
          Object.freeze({
            currency: code,
            weight: ratioOf(entry[0], total),
            ret: entry[2].toFloat() + 0.0,
            contribution: ratioOf(entry[1], total),
          }),
      )
      .sort(
        (a, b) => byNegAbs(a.contribution, b.contribution) || comparePyStr(a.currency, b.currency),
      );
    return freezeResult({
      start,
      end,
      segments,
      unassigned,
      currencyContribution: ratioOf(currencyTotal, total),
      currencies,
      explained: ratioOf(explained, total),
      newPositions,
      stale: [...stale].sort(comparePyStr),
    });
  });
}

function freezeResult(a: SegmentAttribution): SegmentAttribution {
  return Object.freeze(a);
}

// ------------------------------------------------------------------ topic trends (P7)

/** Days of `trend_1w` and `trend_4w`. */
export const TREND_WINDOWS: readonly number[] = Object.freeze([7, 28]);

export interface MemberMove {
  readonly instrumentId: InstrumentId;
  /** Held at `end` (else only watched). */
  readonly held: boolean;
  /** Local price return per `TREND_WINDOWS` window (null without usable closes). */
  readonly returns: readonly (number | null)[];
}

/**
 * A segment's price trend independent of the holdings' weights: the equal-weighted local return of
 * its held and watched instruments.
 */
export interface SegmentTrend {
  readonly segment: string;
  /** Per `TREND_WINDOWS` window; null when no member has usable closes there. */
  readonly trends: readonly (number | null)[];
  /** Members with a usable return in the first (1w) window. */
  readonly members: number;
  /** Every member (held first, then by |1w return|). */
  readonly instruments: readonly MemberMove[];
}

/**
 * The local return close on/before `end - days` -> close on/before `end`; null when either close is
 * missing, older than `maxPriceAgeDays` before its day, or both are the same bar.
 */
export function memberReturn(
  bars: readonly PriceBar[],
  end: CalendarDate,
  days: number,
  maxPriceAgeDays: number, // float-ok: a day count (Python int)
): number | null {
  const start = addDays(end, -days);
  const last = closeOnOrBefore(bars, end);
  const first = closeOnOrBefore(bars, start);
  if (last === null || first === null || first.close.lte(ZERO) || first.date >= last.date) {
    return null;
  }
  if (daysBetween(last.date, end) > maxPriceAgeDays) return null;
  if (daysBetween(first.date, start) > maxPriceAgeDays) return null;
  return last.close.div(first.close).sub(ONE).toFloat() + 0.0;
}

/**
 * Per segment the equal-weighted local price return over each `TREND_WINDOWS` window of its
 * `members` (instrument -> [segment, held at `end`]): held and watched instruments count alike; an
 * instrument without usable closes in a window is left out of that window's mean. Every segment with
 * a member is in the result (trends null when no member has prices).
 */
export function segmentTrends(
  members: ReadonlyMap<InstrumentId, readonly [string, boolean]>,
  prices: ReadonlyMap<InstrumentId, readonly PriceBar[]>,
  end: CalendarDate,
  options: { readonly maxPriceAgeDays?: number } = {}, // float-ok: a day count (Python int)
): Map<string, SegmentTrend> {
  return exactDecimals(() => {
    const maxPriceAgeDays = options.maxPriceAgeDays ?? DEFAULT_MAX_PRICE_AGE_DAYS;
    const grouped = new Map<string, MemberMove[]>();
    for (const [iid, [segment, held]] of members) {
      const series = prices.get(iid) ?? [];
      const moves = TREND_WINDOWS.map((d) => memberReturn(series, end, d, maxPriceAgeDays));
      const list = grouped.get(segment);
      const move: MemberMove = Object.freeze({ instrumentId: iid, held, returns: moves });
      if (list === undefined) grouped.set(segment, [move]);
      else list.push(move);
    }
    const out = new Map<string, SegmentTrend>();
    for (const [segment, items] of grouped) {
      const trends: (number | null)[] = [];
      for (let i = 0; i < TREND_WINDOWS.length; i++) {
        const values = items.map((m) => m.returns[i] ?? null).filter((v) => v !== null);
        trends.push(values.length > 0 ? pySum(values) / values.length + 0.0 : null);
      }
      const ordered = [...items].sort(
        (a, b) =>
          Number(!a.held) - Number(!b.held) ||
          Number((a.returns[0] ?? null) === null) - Number((b.returns[0] ?? null) === null) ||
          -Math.abs(a.returns[0] ?? 0.0) - -Math.abs(b.returns[0] ?? 0.0) ||
          comparePyStr(a.instrumentId, b.instrumentId),
      );
      out.set(
        segment,
        Object.freeze({
          segment,
          trends,
          members: items.filter((m) => (m.returns[0] ?? null) !== null).length,
          instruments: ordered,
        }),
      );
    }
    return out;
  });
}
