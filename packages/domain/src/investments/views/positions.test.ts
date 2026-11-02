/** Pure Python view oracles over the shared invented household; store loading has separate acceptance. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { D, Decimal } from "../../decimal.js";
import { annotateSubjects } from "../plan/annotations.js";
import { Freshness, planInstant } from "../plan/freshness.js";
import { formatInstant } from "../research/index.js";
import { strategyStatus, usableConfig } from "../strategy/index.js";
import { accountsView } from "./accounts.js";
import { allocationView } from "./allocation.js";
import { overviewView } from "./overview.js";
import { positionChartView } from "./positionChart.js";
import { positionDetailView } from "./positionDetail.js";
import { positionsView } from "./positions.js";
import {
  ACCOUNT_FLOAT_PATHS,
  ALLOCATION_FLOAT_PATHS,
  OVERVIEW_FLOAT_PATHS,
  POSITION_CHART_FLOAT_PATHS,
  POSITION_DETAIL_FLOAT_PATHS,
  POSITIONS_FLOAT_PATHS,
  type PortfolioProjectionInput,
  type PortfolioViewState,
  type PositionHistory,
  type ViewFacts,
  type ViewOptions,
  WATCHLIST_FLOAT_PATHS,
} from "./types.js";
import { watchlistView } from "./watchlist.js";

interface Vector {
  label: string;
  view: string;
  input: Record<string, unknown>;
  expected: unknown;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/portfolio-views.json", import.meta.url), "utf8"),
) as { cases: Vector[] };
/** Tagged fixture values, not a production payload heuristic. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.$decimal === "string") return D(r.$decimal);
    if (typeof r.$datetime === "string") return parseDateTime(r.$datetime);
    if (typeof r.$instant === "string") return planInstant(parseDateTime(r.$instant));
    if (Array.isArray(r.$map))
      return new Map(
        r.$map.map((entry) => {
          const [k, v] = entry as [unknown, unknown];
          return [decode(k), decode(v)];
        }),
      );
    if (Array.isArray(r.$set)) return new Set(r.$set.map(decode));
    if (typeof r.$float === "string")
      return r.$float === "inf" ? Infinity : r.$float === "-inf" ? -Infinity : NaN;
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
function selected(paths: readonly string[], actual: readonly string[]): boolean {
  return paths.some((p) => {
    const parts = p.split(".");
    return (
      parts.length === actual.length &&
      parts.every((part, index) => part === "*" || part === actual[index])
    );
  });
}
function wire(value: unknown, paths: readonly string[], at: readonly string[] = []): unknown {
  if (value instanceof Decimal) return selected(paths, at) ? value.toFloat() : value.toString();
  if (value instanceof Freshness)
    return {
      state: value.state,
      reasons: value.reasons.map((r) => ({
        code: r.code,
        at: r.at === null ? null : formatInstant(r.at),
        ...(r.noteId === undefined ? {} : { note_id: r.noteId }),
        ...(r.signalId === undefined ? {} : { signal_id: r.signalId }),
        ...(r.alertId === undefined ? {} : { alert_id: r.alertId }),
        ...(r.kind === undefined ? {} : { kind: r.kind }),
        ...(r.relation === undefined ? {} : { relation: r.relation }),
        ...(r.count === undefined ? {} : { count: r.count }),
      })),
    };
  if (typeof value === "number" && !Number.isFinite(value))
    return { $float: Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf" };
  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([k, v]) => [String(k), wire(v, paths, [...at, String(k)])]),
    );
  if (Array.isArray(value)) return value.map((v, index) => wire(v, paths, [...at, String(index)]));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, wire(v, paths, [...at, k])]),
    );
  return value;
}
function history(value: unknown): PositionHistory {
  const h = value as {
    theses: Record<string, unknown>[];
    decisions: Record<string, unknown>[];
    manual: Record<string, unknown>[];
  };
  const time = (v: unknown) => (v === null ? null : parseDateTime(String(v)));
  const amount = (v: unknown) => (v === null ? null : D(String(v)));
  return {
    theses: h.theses.map((t) => ({
      id: t.id,
      instrumentId: t.instrument_id,
      entryType: t.entry_type,
      thesis: t.thesis,
      invalidation: t.invalidation,
      exitPlan: t.exit_plan,
      sizePlan: t.size_plan,
      reviewedAt: time(t.reviewed_at),
      createdAt: time(t.created_at),
      updatedAt: time(t.updated_at),
      coreChangedAt: time(t.core_changed_at),
      exitPlanChangedAt: time(t.exit_plan_changed_at),
    })) as PositionHistory["theses"],
    decisions: h.decisions.map((d) => ({
      id: d.id,
      signalId: d.signal_id,
      signalIds: d.signal_ids,
      instrumentId: d.instrument_id,
      accountId: d.account_id,
      action: d.action,
      quantity: amount(d.quantity),
      price: amount(d.price),
      currency: d.currency,
      reason: d.reason,
      createdAt: time(d.created_at),
    })) as PositionHistory["decisions"],
    manualValuations: h.manual.map((v) => ({
      id: v.id,
      instrumentId: v.instrument_id,
      asOf: v.as_of,
      unitValue: amount(v.unit_value),
      currency: v.currency,
      note: v.note,
    })) as PositionHistory["manualValuations"],
  };
}
function input(v: Vector) {
  const raw = decode(v.input) as Record<string, unknown>,
    status = strategyStatus(
      raw.strategyFiles as Parameters<typeof strategyStatus>[0],
      raw.strategyLatest as Parameters<typeof strategyStatus>[1],
    );
  const state = { ...(raw.state as PortfolioViewState), config: usableConfig(status) },
    facts = raw.facts as ViewFacts,
    options = raw.options as ViewOptions;
  const base: PortfolioProjectionInput = {
    state,
    facts,
    options,
    annotations: annotateSubjects(facts.subjects, facts.clock, options.lang),
  };
  return { raw, status, base };
}
function project(v: Vector) {
  const { raw, status, base } = input(v);
  switch (v.view) {
    case "positions":
      return wire(positionsView(base), POSITIONS_FLOAT_PATHS);
    case "allocation_view":
      return wire(allocationView(base), ALLOCATION_FLOAT_PATHS);
    case "accounts_view":
      return wire(
        accountsView(base.state.accounts, raw.withoutState ? null : base.state),
        ACCOUNT_FLOAT_PATHS,
      );
    case "overview":
      return wire(
        overviewView({
          ...base,
          strategyStatus: status,
          newestRateDate: raw.newestRateDate as string | null,
          newestBarDate: raw.newestBarDate as string | null,
        }),
        OVERVIEW_FLOAT_PATHS,
      );
    case "watchlist_view":
      return wire(watchlistView(base), WATCHLIST_FLOAT_PATHS);
    case "position_detail":
      return wire(
        positionDetailView({
          ...base,
          instrument: raw.instrument as Parameters<typeof positionDetailView>[0]["instrument"],
          detailBars: raw.detailBars as Parameters<typeof positionDetailView>[0]["detailBars"],
          chartBars: raw.chartBars as Parameters<typeof positionDetailView>[0]["chartBars"],
          history: history(raw.historyWire),
        }),
        POSITION_DETAIL_FLOAT_PATHS,
      );
    case "position_chart":
      return wire(
        positionChartView({
          ...base,
          instrument: raw.instrument as Parameters<typeof positionChartView>[0]["instrument"],
          bars: raw.chartBars as Parameters<typeof positionChartView>[0]["bars"],
        }),
        POSITION_CHART_FLOAT_PATHS,
      );
    default:
      throw new Error("unknown synthetic projection");
  }
}
it.each(vectors.cases)("matches actual Python $label $view", (v) =>
  expect(project(v)).toEqual(v.expected),
);
it("retains first input order when distinct Decimal values have equal Python float presentation keys", () => {
  const v = vectors.cases.find((v) => v.label === "wire_float_tie" && v.view === "positions");
  expect(v).toBeDefined();
  const result = project(v!) as { positions: { instrument: { id: string }; value: number }[] };
  expect(result.positions.map((p) => p.instrument.id)).toEqual(["1", "2"]);
  expect(result.positions[0]?.value).toBe(result.positions[1]?.value);
});
it("keeps detail empty730day high distinct from full-history chart high and last", () => {
  const detail = vectors.cases.find(
      (v) => v.label === "sparse_chart_history" && v.view === "position_detail",
    ),
    chart = vectors.cases.find(
      (v) => v.label === "sparse_chart_history" && v.view === "position_chart",
    );
  expect(detail).toBeDefined();
  expect(chart).toBeDefined();
  expect((project(detail!) as { high_52w: unknown }).high_52w).toBeNull();
  const result = project(chart!) as { high_52w: unknown; last: unknown; series: unknown[] };
  expect(result.high_52w).toBe(9);
  expect(result.last).not.toBeNull();
  expect(result.series).toEqual([]);
});
it("serializes declared nonnull plan_at explicitly without guessing DateTime-shaped payloads", () => {
  const v = vectors.cases.find(
    (v) =>
      v.view === "positions" &&
      (v.expected as { positions?: { instrument: { plan_at: unknown } }[] }).positions?.some(
        (p) => p.instrument.plan_at !== null,
      ),
  );
  expect(v).toBeDefined();
  const result = project(v!) as { positions: { instrument: { plan_at: unknown } }[] };
  expect(result.positions.some((p) => typeof p.instrument.plan_at === "string")).toBe(true);
});
