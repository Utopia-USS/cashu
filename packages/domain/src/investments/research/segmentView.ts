/**
 * The market segments view of one profile (P5 / P7, Python `research/segment_service.py`), pure part:
 * the weekly / 4-week move attribution by segment and currency over a performance computation
 * (`_attribute`, `_start_portfolio` with `_fallback_value`, `_portfolio_return`), the topic trends of
 * held and watched instruments (`topic_trends`), and the rows of `GET /research/segments` (`_row`,
 * `_row_order`, `segments_view`). The segment notes and topic theses come in as prepared facts (the
 * store reads them). Weights, returns and contributions are fractions rounded to 6 digits; no amounts.
 */

import type { UiLang } from "../../core/i18n.js";
import { addDays, daysBetween } from "../../dates.js";
import { type Decimal, ONE, roundFloat, ZERO } from "../../decimal.js";
import { AssetClass, ValuationMode } from "../domain/enums.js";
import type { FxLookup } from "../domain/fx.js";
import type { Instrument } from "../domain/instrument.js";
import { instrumentLabel } from "../domain/instrument.js";
import type { PriceBar } from "../domain/marketData.js";
import {
  holdingCostBasis,
  type MarketView,
  marketView,
  type PortfolioSnapshot,
  type ValuedHolding,
  viewManualValuation,
  viewSeries,
} from "../domain/snapshot.js";
import {
  asProfileId,
  type CalendarDate,
  type Currency,
  type InstrumentId,
} from "../domain/values.js";
import { periodReturn, twrIndex } from "../performance/returns.js";
import {
  attributeSegments,
  closeOnOrBefore,
  type SegmentAttribution,
  type SegmentMove,
  type SegmentTrend,
  type StartHolding,
  type StartPortfolio,
  segmentTrends,
  snapshotOpenings,
  startHolding,
  startPortfolio,
} from "../performance/segmentAttribution.js";
import { combineSeries } from "../performance/series.js";
import {
  type ComputedPerformance,
  hasHistory,
  type PerformanceInputs,
} from "../performance/service.js";
import { buildSnapshot } from "../portfolio/snapshotBuilder.js";
import { valuePortfolio } from "../portfolio/valuation.js";
import {
  catalogOrder,
  isSegment,
  segmentGroup,
  segmentLabel,
  segmentOf,
  UNASSIGNED,
} from "./segments.js";

/** Python `WINDOWS`: window key -> days. */
export const SEGMENT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["1w", 7],
  ["4w", 28],
]);
export const DEFAULT_SEGMENT_WINDOW = "1w";
export const NOTES_WEEKS = 8;
export const DIGEST_ROWS = 6;
export const BRIEFS_PER_TOPIC = 3;
const DIGITS = 6;
/** Bars read before the longest trend window (a start close may be a few days older). */
export const TREND_MARGIN_DAYS = 10;

/** Python `_r`: a fraction rounded to 6 digits, never -0.0; null stays null. */
export function roundShare(value: number | null): number | null {
  // float-ok: shares and returns are Python floats
  return value === null ? null : roundFloat(value, DIGITS) + 0.0;
}

const share = (value: number): number => roundShare(value) as number;

/** One window's attribution with what the rows need (Python `Attributed`). */
export interface Attributed {
  readonly attribution: SegmentAttribution;
  /** Time-weighted return of the whole portfolio over the window; null when the series is incomplete. */
  readonly portfolioReturn: number | null;
  readonly labels: ReadonlyMap<InstrumentId, string>;
  readonly base: string;
  readonly end: CalendarDate;
  readonly heldAtEnd: ReadonlySet<InstrumentId>;
  /** The performance computation's inputs (instruments, bars, policy) the topic trends reuse. */
  readonly inputs: PerformanceInputs;
}

function anyRate(
  fx: FxLookup,
  currency: Currency,
  base: Currency,
  day: CalendarDate,
): Decimal | null {
  if (currency === base) return ONE;
  return fx.quoteOnOrBefore(currency, day, base)?.rate ?? null;
}

/**
 * Python `_fallback_value`: a holding the valuation left without a value at `start`, valued from the
 * nearest close and rate on or before `start` whatever their age; null without any price or rate.
 */
function fallbackValue(
  v: ValuedHolding,
  view: MarketView,
  snapshot: PortfolioSnapshot,
  fx: FxLookup,
  base: Currency,
  start: CalendarDate,
): Decimal | null {
  const { holding, instrument } = v;
  if (v.valuationMode === ValuationMode.COST) {
    const cost = holdingCostBasis(holding);
    const rate = anyRate(fx, holding.currency, base, start);
    return cost === null || rate === null ? null : cost.mul(rate);
  }
  if (v.valuationMode === ValuationMode.MANUAL) {
    const manual = viewManualValuation(view, holding.instrumentId, start);
    if (manual === null) return null;
    const rate = anyRate(fx, manual.currency, base, start);
    return rate === null ? null : holding.quantity.mul(manual.unitValue).mul(rate);
  }
  const bar = closeOnOrBefore(viewSeries(view, holding.instrumentId), start);
  let price: Decimal;
  let currency: Currency;
  if (bar !== null) {
    price = bar.close;
    currency = instrument.currency;
  } else {
    const last = snapshot.lastTradePrices.get(holding.instrumentId);
    if (last === undefined || last.date > start) return null;
    price = last.price;
    currency = last.currency;
  }
  const rate = anyRate(fx, currency, base, start);
  return rate === null ? null : holding.quantity.mul(price).mul(rate);
}

/**
 * Python `_start_portfolio`: the holdings at `start` with their base values (the valuation's, else the
 * fallback, flagged stale), `T0` and the instruments held there (snapshot openings count as held).
 */
export function startPortfolioOf(inputs: PerformanceInputs, start: CalendarDate): StartPortfolio {
  const then = buildSnapshot(asProfileId("0"), snapshotOpenings(inputs.txns, start), start, {
    renames: inputs.renames,
  });
  const held = new Set(then.holdings.map((h) => h.instrumentId));
  const pick = <T>(m: ReadonlyMap<InstrumentId, T>) => new Map([...m].filter(([k]) => held.has(k)));
  const view = marketView({
    asOf: start,
    instruments: pick(inputs.instruments),
    bars: new Map(
      [...held].map((k) => [k, (inputs.bars.get(k) ?? []).filter((b) => b.date <= start)] as const),
    ),
    manualValuations: pick(inputs.manual),
  });
  const valued = valuePortfolio(then, view, inputs.fx, inputs.base, inputs.policy.maxPriceAgeDays, {
    maxFxAgeDays: inputs.policy.maxFxAgeDays,
  });
  let total = valued.totalBase;
  const holdings: StartHolding[] = [];
  const unvalued = new Set<InstrumentId>();
  for (const v of valued.valued) {
    const cashLike = v.instrument.assetClass === AssetClass.CASH;
    let value = v.marketValueBase;
    let stale = v.isStale;
    if (value === null) {
      value = fallbackValue(v, view, then, inputs.fx, inputs.base, start);
      if (value === null) {
        unvalued.add(v.holding.instrumentId);
        continue;
      }
      total = total.add(value);
      stale = true;
    }
    if (cashLike) continue; // in T0 only
    holdings.push(
      startHolding({
        instrumentId: v.holding.instrumentId,
        currency: v.instrument.currency,
        valueBase: value,
        market: v.valuationMode === ValuationMode.MARKET,
        stale,
      }),
    );
  }
  for (const c of valued.cash) {
    if (c.amountBase === null && c.cash.amount.gt(ZERO)) {
      const rate = anyRate(inputs.fx, c.cash.currency, inputs.base, start);
      if (rate !== null) total = total.add(c.cash.amount.mul(rate));
    }
  }
  const valuedIds = new Set(holdings.map((h) => h.instrumentId));
  return startPortfolio({
    totalBase: total,
    holdings,
    unvalued: [...unvalued].filter((i) => !valuedIds.has(i)).sort(),
    held: [...held],
  });
}

/** Python `_portfolio_return`: the TWR of the whole portfolio over `start` -> `end`, else null. */
export function portfolioReturn(
  computed: ComputedPerformance,
  start: CalendarDate,
  end: CalendarDate,
): number | null {
  const dates = computed.series.dates;
  const first = dates[0];
  if (!hasHistory(computed) || first === undefined || start < first) return null;
  const i0 = daysBetween(first, start);
  const i1 = daysBetween(first, end);
  if (i1 >= dates.length || i1 <= i0) return null;
  const combined = combineSeries(computed.series);
  const complete = combined.complete.slice(i0, i1 + 1);
  if (!complete.every(Boolean)) return null;
  const index = twrIndex(
    combined.values.slice(i0, i1 + 1),
    combined.flows.slice(i0, i1 + 1),
    complete,
  );
  return periodReturn(index);
}

function emptyAttribution(start: CalendarDate, end: CalendarDate): SegmentAttribution {
  return {
    start,
    end,
    segments: [],
    unassigned: null,
    currencyContribution: 0.0,
    currencies: [],
    explained: 0.0,
    newPositions: 0,
    stale: [],
  };
}

/** Python `_attribute`: the attribution of the `days` before the computation's end. */
export function attributeWindow(computed: ComputedPerformance, days: number): Attributed {
  const inputs = computed.inputs;
  const end = computed.end;
  const start = addDays(end, -days);
  const labels = new Map([...inputs.instruments].map(([k, v]) => [k, instrumentLabel(v)]));
  const base = String(inputs.base);
  if (inputs.txns.length === 0) {
    return {
      attribution: emptyAttribution(start, end),
      portfolioReturn: null,
      labels,
      base,
      end,
      heldAtEnd: new Set(),
      inputs,
    };
  }
  const nowHeld = buildSnapshot(asProfileId("0"), inputs.txns, end, { renames: inputs.renames });
  const heldAtEnd = new Set(nowHeld.holdings.map((h) => h.instrumentId));
  const segmentKey = (iid: InstrumentId): string | null => {
    const inst = inputs.instruments.get(iid);
    return inst === undefined ? null : segmentOf(inst, inst.segment, inst.segmentBy)[0];
  };
  const attribution = attributeSegments(
    startPortfolioOf(inputs, start),
    inputs.bars,
    inputs.fx,
    inputs.base,
    start,
    end,
    segmentKey,
    { heldAtEnd, maxPriceAgeDays: inputs.policy.maxPriceAgeDays },
  );
  return {
    attribution,
    portfolioReturn: portfolioReturn(computed, start, end),
    labels,
    base,
    end,
    heldAtEnd,
    inputs,
  };
}

/** Python `Trends`. */
export interface Trends {
  readonly bySegment: ReadonlyMap<string, SegmentTrend>;
  readonly labels: ReadonlyMap<InstrumentId, string>;
}

/**
 * Python `topic_trends`: per segment the equal-weighted 1w / 4w price trend of the instruments held
 * at the window's end and the watched ones. `extraInstruments` / `extraBars`: watched instruments and
 * their bars the computation does not hold (the store reads them).
 */
export function topicTrends(
  found: Attributed,
  watched: Iterable<InstrumentId>,
  extraInstruments: ReadonlyMap<InstrumentId, Instrument> = new Map(),
  extraBars: ReadonlyMap<InstrumentId, readonly PriceBar[]> = new Map(),
): Trends {
  const instruments = new Map([...found.inputs.instruments, ...extraInstruments]);
  const bars = new Map([...found.inputs.bars, ...extraBars]);
  const members = new Map<InstrumentId, readonly [string, boolean]>();
  for (const iid of new Set([...found.heldAtEnd, ...watched])) {
    const inst = instruments.get(iid);
    if (inst === undefined || inst.assetClass === AssetClass.CASH) continue;
    const key = segmentOf(inst, inst.segment, inst.segmentBy)[0];
    if (key !== null) members.set(iid, [key, found.heldAtEnd.has(iid)]);
  }
  return {
    bySegment: segmentTrends(members, bars, found.end, {
      maxPriceAgeDays: found.inputs.policy.maxPriceAgeDays,
    }),
    labels: new Map(
      [...members.keys()].map((iid) => [iid, instrumentLabel(instruments.get(iid) as Instrument)]),
    ),
  };
}

/** The segment note facts of one row (Python `SegmentNotes`, already in the payload's shapes). */
export interface SegmentNoteFacts {
  /** `brief_note(latest)`: the newest active note; null without one. */
  readonly note: Readonly<Record<string, unknown>> | null;
  /** The latest active note's observation date (for `note_this_week`). */
  readonly latestObserved: CalendarDate | null;
  readonly unread: number;
  readonly notes8w: number;
  readonly lastNoteAt: string | null;
  readonly briefs: readonly unknown[];
  readonly valuation: Readonly<Record<string, unknown>> | null;
}

function instrumentsOf(move: SegmentMove, labels: ReadonlyMap<InstrumentId, string>) {
  return move.instruments.map((m) => ({
    instrument_id: String(m.instrumentId),
    label: labels.get(m.instrumentId) ?? null,
    weight: share(m.weight),
    contribution: share(m.contribution),
    return: roundShare(m.ret),
  }));
}

function membersOf(trend: SegmentTrend | undefined, labels: ReadonlyMap<InstrumentId, string>) {
  if (trend === undefined) return [];
  return trend.instruments.map((m) => ({
    instrument_id: String(m.instrumentId),
    label: labels.get(m.instrumentId) ?? null,
    held: m.held,
    return_1w: roundShare(m.returns[0] ?? null),
    return_4w: roundShare(m.returns[1] ?? null),
  }));
}

export interface SegmentsViewInput {
  readonly window: string;
  readonly found: Attributed;
  readonly trends: Trends;
  /** Per segment key (notes with a segment; dismissed ones left out). */
  readonly notes: ReadonlyMap<string, SegmentNoteFacts>;
  /** The live topic theses in their API shape (`thesis_dict`), per segment. */
  readonly theses: ReadonlyMap<string, unknown>;
  /** Today's ISO week label (Python `iso_week(now.date())`). */
  readonly week: string;
  readonly isoWeekOf: (day: CalendarDate) => string;
  readonly lang: UiLang;
}

/**
 * Python `segments_view` payload: rows for segments with exposure at the start, with a held or
 * watched instrument, with an active note or with a topic thesis; rows with exposure by
 * |contribution|, then the others by |trend_1w| (none last), ties in catalog order.
 */
export function segmentsPayload(input: SegmentsViewInput) {
  const { found, trends, lang } = input;
  const result = found.attribution;
  const moves = new Map(
    result.segments.flatMap((m) => (m.segment === null ? [] : [[m.segment, m] as const])),
  );
  const keys = new Set(moves.keys());
  for (const k of trends.bySegment.keys()) if (isSegment(k)) keys.add(k);
  for (const [k, n] of input.notes) if (n.note !== null && isSegment(k)) keys.add(k);
  for (const k of input.theses.keys()) if (isSegment(k)) keys.add(k);
  const rows = [...keys].map((key) => {
    const move = moves.get(key);
    const notes = input.notes.get(key);
    const trend = trends.bySegment.get(key);
    return {
      segment: key,
      label: segmentLabel(key, lang),
      group: segmentGroup(key),
      weight: move === undefined ? 0.0 : share(move.weight),
      contribution: move === undefined ? 0.0 : share(move.contribution),
      return: move === undefined ? null : roundShare(move.ret),
      instruments: move === undefined ? [] : instrumentsOf(move, found.labels),
      trend_1w: trend === undefined ? null : roundShare(trend.trends[0] ?? null),
      trend_4w: trend === undefined ? null : roundShare(trend.trends[1] ?? null),
      members: trend === undefined ? 0 : trend.members,
      member_instruments: membersOf(trend, trends.labels),
      note: notes?.note ?? null,
      note_this_week:
        notes !== undefined &&
        notes.latestObserved !== null &&
        input.isoWeekOf(notes.latestObserved) === input.week,
      unread: notes?.unread ?? 0,
      notes_8w: notes?.notes8w ?? 0,
      last_note_at: notes?.lastNoteAt ?? null,
      briefs: notes === undefined ? [] : [...notes.briefs.slice(0, BRIEFS_PER_TOPIC)],
      thesis: input.theses.get(key) ?? null,
      valuation: notes?.valuation ?? null,
    };
  });
  const order = (r: (typeof rows)[number]): readonly (number | boolean)[] =>
    moves.has(r.segment)
      ? [0, -Math.abs(r.contribution ?? 0.0), catalogOrder(r.segment)]
      : [1, r.trend_1w === null, -Math.abs(r.trend_1w ?? 0.0), catalogOrder(r.segment)];
  rows.sort((a, b) => {
    const ka = order(a);
    const kb = order(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      const x = Number(ka[i]);
      const y = Number(kb[i]);
      if (x !== y) return x - y;
    }
    return 0;
  });
  const unassigned = result.unassigned;
  const explained = roundShare(result.explained);
  const ret = roundShare(found.portfolioReturn);
  return {
    as_of: found.end,
    start: result.start,
    end: result.end,
    window: input.window,
    base_currency: found.base,
    portfolio_return: ret,
    explained,
    residual:
      found.portfolioReturn === null ? null : roundShare(found.portfolioReturn - result.explained),
    new_positions: result.newPositions,
    stale: result.stale.map(String),
    segments: rows,
    unassigned:
      unassigned === null
        ? null
        : {
            segment: UNASSIGNED,
            label: segmentLabel(UNASSIGNED, lang),
            weight: share(unassigned.weight),
            contribution: share(unassigned.contribution),
            return: roundShare(unassigned.ret),
            instruments: instrumentsOf(unassigned, found.labels),
          },
    currency: {
      contribution: share(result.currencyContribution),
      currencies: result.currencies.map((c) => ({
        currency: c.currency,
        weight: share(c.weight),
        return: share(c.ret),
        contribution: share(c.contribution),
      })),
    },
  };
}

export type SegmentsPayload = ReturnType<typeof segmentsPayload>;
export type SegmentRow = SegmentsPayload["segments"][number];

/**
 * Python `_digest_segments` on a computed view: the digest's rows (topics with a note from this week
 * first, then the view's order, at most `DIGEST_ROWS`) and the rest of the view.
 */
export function digestSegments(view: SegmentsPayload): {
  segments: SegmentRow[];
  market: Omit<SegmentsPayload, "segments">;
} {
  const { segments, ...market } = view;
  const rows = segments
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(!a.r.note_this_week) - Number(!b.r.note_this_week) || a.i - b.i)
    .map(({ r }) => r);
  return { segments: rows.slice(0, DIGEST_ROWS), market };
}
