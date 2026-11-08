/** Watched hard-price facts and nearest live alert, reusing the complete native alert evaluator. */
import { addDays, daysBetween, type IsoDate } from "../../dates.js";
import { D, type Decimal, floatRepr, roundFloat } from "../../decimal.js";
import { type AlertKind, evaluateAlert } from "../alerts/index.js";
import { type Instrument, openedOn, type PriceBar } from "../domain/index.js";
import { closes30d, instrumentView, viewTimestamp } from "./positions.js";
import type { PortfolioProjectionInput, ViewAlert } from "./types.js";

const ratioBetween = (next: Decimal, previous: Decimal): number | null =>
  previous.gt(D("0")) ? next.div(previous).sub(D("1")).toFloat() : null;
function numeric(value: unknown): Decimal | null {
  return value == null ? null : D(typeof value === "number" ? floatRepr(value) : String(value));
}
function alertLevel(
  row: ViewAlert,
  instrument: Instrument,
  bars: readonly PriceBar[],
  asOf: IsoDate,
): Decimal | null {
  const outcome = evaluateAlert(
    {
      id: row.id,
      kind: row.kind as AlertKind,
      scope: "instrument",
      params: row.params,
      title: row.title,
      severity: row.severity,
      polarity: row.polarity,
      instrument,
    },
    { asOf, bars: new Map([[instrument.id, bars]]), maxPriceAgeDays: 10000 },
  ).outcome;
  const details =
    outcome.type === "fired"
      ? outcome.candidate.payload
      : outcome.type === "not_fired"
        ? outcome.details
        : {};
  if (row.kind === "price_above" || row.kind === "price_below") return numeric(details.level);
  if (row.kind === "sma_cross") return numeric(details.sma);
  if (row.kind === "new_high") return numeric(details.previous_high);
  if (row.kind === "drawdown_from_high") {
    const high = numeric(details.high),
      threshold = numeric(Object.hasOwn(row.params, "threshold") ? row.params.threshold : 0);
    return high === null || threshold === null ? null : high.mul(D("1").sub(threshold));
  }
  if (row.kind !== "range_breakout") return null;
  const low = numeric(details.range_low),
    high = numeric(details.range_high),
    close = numeric(details.close);
  if (low === null || high === null || close === null) return null;
  const width = numeric(details.range_pct),
    limit = numeric(details.max_range_pct);
  if (width !== null && limit !== null && width.gt(limit.add(D("1e-9")))) return null;
  const direction = row.params.direction;
  if (direction === "up") return high;
  if (direction === "down") return low;
  return high.sub(close).abs().lte(close.sub(low).abs()) ? high : low;
}
export interface NearestAlert {
  readonly alert_id: string;
  readonly kind: string;
  readonly title: string;
  readonly level: Decimal;
  readonly distance_pct: number;
}
export function nearestAlert(
  alerts: readonly ViewAlert[],
  instrument: Instrument | null,
  bars: readonly PriceBar[],
  asOf: IsoDate,
): NearestAlert | null {
  const close = bars.at(-1)?.close;
  if (instrument === null || close === undefined || close.lte(D("0"))) return null;
  let best: NearestAlert | null = null;
  for (const a of alerts) {
    if (!["active", "triggered", "snoozed"].includes(a.status) || a.instrumentId === null) continue;
    const level = alertLevel(a, instrument, bars, asOf);
    if (level === null) continue;
    const distance = level.sub(close).div(close).toFloat();
    // Python compares against the previously stored rounded distance, including rounded ties.
    if (best === null || Math.abs(distance) < Math.abs(best.distance_pct))
      best = {
        alert_id: a.id,
        kind: a.kind,
        title: a.title,
        level,
        distance_pct: roundFloat(distance, 6),
      };
  }
  return best;
}
export function watchlistView(input: PortfolioProjectionInput) {
  const { state, facts, annotations } = input,
    asOf = state.asOf,
    since = addDays(asOf, -400),
    maxAge = state.config?.data.maxPriceAgeDays ?? 5;
  return facts.watched.map((w) => {
    const inst = state.instruments.get(w.instrumentId) ?? null,
      bars = (state.historyBars.get(w.instrumentId) ?? []).filter(
        (b) => b.date >= since && b.date <= asOf,
      ),
      held = state.snapshot.holdings.filter((h) => h.instrumentId === w.instrumentId),
      annotation = annotations.get(w.instrumentId),
      alerts = facts.alerts.filter((a) => a.instrumentId === w.instrumentId),
      last = bars.at(-1);
    const year = bars.slice(-252),
      high = year.length ? year.reduce((a, b) => (a.close.gte(b.close) ? a : b)) : null;
    return {
      id: w.id,
      instrument_id: w.instrumentId,
      instrument:
        inst === null
          ? null
          : {
              ...instrumentView(inst, held.length > 0, openedOn(held, state.snapshot.realized)),
              plan_freshness: annotation?.freshness ?? null,
            },
      note: w.note,
      tags: w.tags,
      source: w.source,
      added_at: viewTimestamp(w.addedAt),
      held: held.length > 0,
      price_source:
        inst !== null &&
        inst.aliases.some((a) => a.namespace === "yahoo" || a.namespace === "stooq"),
      price:
        last === undefined || high === null
          ? null
          : {
              close: last.close,
              date: last.date,
              currency: last.currency ?? inst?.currency ?? "",
              stale: daysBetween(last.date, asOf) > maxAge,
              change_1d:
                bars.length >= 2 ? ratioBetween(last.close, bars[bars.length - 2]!.close) : null,
              change_1m:
                bars.length >= 22 ? ratioBetween(last.close, bars[bars.length - 22]!.close) : null,
              high_52w: high.close,
              high_52w_date: high.date,
              from_high_52w: high.close.isZero()
                ? null
                : last.close.sub(high.close).div(high.close).toFloat(),
              bars: bars.length,
            },
      closes_30d: closes30d(bars, asOf),
      alerts: {
        count: alerts.length,
        live: alerts.filter((a) => ["active", "triggered", "snoozed"].includes(a.status)).length,
        triggered: alerts.filter((a) => a.status === "triggered").length,
        nearest: nearestAlert(alerts, inst, bars, asOf),
      },
      research_unread: facts.unread.get(w.instrumentId) ?? 0,
      hints: annotation?.hints ?? [],
    };
  });
}
