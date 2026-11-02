/** Actual Python synthetic hint table calls, including rounded threshold ties and malformed values. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { D, Decimal } from "../../decimal.js";
import { Freshness, type FreshnessReason, type FreshnessState } from "./freshness.js";
import { type HintFacts, instrumentHints } from "./hints.js";

interface Input {
  held: boolean;
  health: string;
  has_thesis: boolean;
  has_exit_plan: boolean;
  plan: string | null;
  predates_thesis: boolean;
  signals: { kind: string; payload: Record<string, unknown>; severity: string | null }[];
  alerts: { alert_id: string; kind: string; title: string | null; order: number }[];
  weight: number | null;
  thesis_tracked: boolean;
  freshness: { state: FreshnessState; reasons: { code: string }[] } | null;
}
const cases = JSON.parse(
  readFileSync(new URL("./fixtures/hints.json", import.meta.url), "utf8"),
) as { cases: readonly [Input, unknown][] };
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.decimal === "string") return D(r.decimal);
    if (typeof r.float === "string")
      return r.float === "inf" ? Infinity : r.float === "-inf" ? -Infinity : NaN;
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
function encode(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return { float: Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf" };
  if (value instanceof Decimal) return { decimal: value.toString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
it.each(cases.cases)("matches actual Python hint table %#", (raw, expected) => {
  const r = decode(raw) as Input;
  const facts: HintFacts = {
    held: r.held,
    health: r.health,
    hasThesis: r.has_thesis,
    hasExitPlan: r.has_exit_plan,
    plan: r.plan,
    predatesThesis: r.predates_thesis,
    signals: r.signals,
    alerts: r.alerts.map((a) => ({
      alertId: a.alert_id,
      kind: a.kind,
      title: a.title,
      order: a.order,
    })),
    weight: r.weight,
    thesisTracked: r.thesis_tracked,
    freshness:
      r.freshness === null
        ? null
        : new Freshness(
            r.freshness.state,
            r.freshness.reasons.map(
              (reason) => ({ code: reason.code, at: null }) as FreshnessReason,
            ),
          ),
  };
  expect(encode(instrumentHints(facts))).toEqual(expected);
});
