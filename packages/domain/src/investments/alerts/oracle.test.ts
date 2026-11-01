/** Actual Python catalog, validation and all-kind evaluator differential oracles; invented data only. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { UiLang } from "../../core/i18n.js";
import { type DateTime, formatDateTime } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import { toCurrency } from "../../money.js";
import type { PyPlain } from "../../pyYaml/plain.js";
import type { InstrumentStatus, PriceBar } from "../domain/index.js";
import type { RuleContext, RuleOutcome } from "../rules/index.js";
import * as f from "../rules/testing/fixtures.js";
import { catalogDicts } from "./catalog.js";
import { evaluateAlert } from "./evaluate.js";
import type { AlertDefinition, AlertKind, AlertScope } from "./types.js";
import { AlertValidationError, validateAlert, validateTag, validateText } from "./validate.js";

type Row = readonly [unknown, unknown];
const vectors = JSON.parse(
  readFileSync(new URL("../../../test/vectors/inv-alerts.json", import.meta.url), "utf8"),
) as { catalog: unknown; validation: Row[]; text: Row[]; tag: Row[]; evaluation: Row[] };
function py(value: unknown): PyPlain {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(py);
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (typeof raw.int === "string") return BigInt(raw.int);
    if (typeof raw.float === "string")
      return raw.float === "inf" ? Infinity : raw.float === "-inf" ? -Infinity : Number(raw.float);
    return new Map(Object.entries(raw).map(([key, v]) => [key, py(v)]));
  }
  throw new Error("invalid synthetic Python value");
}
it("matches the full ordered Python catalog metadata", () =>
  expect(catalogDicts()).toEqual(vectors.catalog));
it.each(vectors.validation)("matches Python validation %#", (raw, expected) => {
  const r = raw as Record<string, unknown>;
  let actual: unknown;
  try {
    actual = validateAlert(py(r.kind), py(r.params), {
      scope: r.scope === undefined ? undefined : py(r.scope),
      hasInstrument: r.hasInstrument === true,
    });
  } catch (error) {
    if (!(error instanceof AlertValidationError)) throw error;
    actual = { issues: error.issues };
  }
  expect(actual).toEqual(expected);
});
it.each(vectors.text)("matches Python title/note validation %#", (raw, expected) => {
  const [title, note] = raw as [unknown, unknown];
  let actual: unknown;
  try {
    actual = { value: validateText(title, note) };
  } catch (error) {
    if (!(error instanceof AlertValidationError)) throw error;
    actual = { issues: error.issues };
  }
  expect(actual).toEqual(expected);
});
it.each(vectors.tag)("matches Python tag normalization %#", (raw, expected) => {
  let actual: unknown;
  try {
    actual = { value: validateTag(raw) };
  } catch (error) {
    if (!(error instanceof AlertValidationError)) throw error;
    actual = { issues: error.issues };
  }
  expect(actual).toEqual(expected);
});
interface Request {
  kind: AlertKind;
  params: Record<string, unknown>;
  closes: string[];
  lang: UiLang;
  scope?: AlertScope;
  currency?: string;
  status?: InstrumentStatus;
  lastDate?: string;
  maxAge?: number;
  volumes?: (number | null)[];
  noInstrument?: boolean;
  malformed?: boolean;
  malformedParams?: boolean;
  ctx?: {
    held?: boolean;
    value?: string | null;
    cost?: string | null;
    cash?: string;
    stale?: boolean;
    manual?: boolean;
    atCost?: boolean;
    secondValue?: string;
    allocation?: { bucket: string; weight: number; target: number; cashHistoryGap?: boolean };
  };
}
const snake: Readonly<Record<string, string>> = {
  ruleId: "rule_id",
  dedupKey: "dedup_key",
  instrumentId: "instrument_id",
  accountId: "account_id",
};
function encode(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return { float: Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf" };
  if (value instanceof Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    if ("microsecond" in value) return formatDateTime(value as DateTime);
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [snake[key] ?? key, encode(v)]),
    );
  }
  return value;
}
function outcome(out: RuleOutcome): unknown {
  if (out.type === "fired") return { candidate: encode(out.candidate) };
  if (out.type === "not_fired")
    return { rule_id: out.ruleId, dedup_key: out.dedupKey, details: encode(out.details) };
  return { rule_id: out.ruleId, reason: out.reason, dedup_key: out.dedupKey };
}
it.each(vectors.evaluation)("matches Python evaluator %#", (input, expected) => {
  const r = input as Request;
  const inst = {
    ...f.instrument("SYN", { currency: toCurrency(r.currency ?? "PLN") }),
    ...(r.status === undefined ? {} : { status: r.status }),
  };
  const bars: readonly PriceBar[] = f.bars(inst, r.closes, r.lastDate ?? f.AS_OF).map((b, i) => ({
    ...b,
    ...(r.volumes === undefined ? {} : { volume: r.volumes[i] ?? null }),
  }));
  let ctx: RuleContext | null = null;
  if (r.ctx !== undefined) {
    const c = r.ctx,
      holdings = [];
    if (c.held) holdings.push(f.h(inst, c));
    if (c.secondValue !== undefined)
      holdings.push(f.h(inst, { value: c.secondValue, account: "account-b" }));
    const allocations =
      c.allocation === undefined ? [] : [f.alloc(c.allocation.bucket, c.allocation)];
    ctx = f.context({
      portfolioValue: f.portfolio(holdings, { cash: c.cash ?? "0" }),
      allocations,
      series: new Map([[inst, bars]]),
      lang: r.lang,
    });
  }
  const valid =
    r.malformed || r.malformedParams
      ? null
      : validateAlert(r.kind, r.params, {
          scope: r.scope,
          hasInstrument:
            !r.noInstrument ||
            [
              "price_above",
              "price_below",
              "change_pct",
              "drawdown_from_high",
              "new_high",
              "sma_cross",
              "range_breakout",
              "volume_spike",
            ].includes(r.kind),
        });
  const definition: AlertDefinition = {
    id: "synthetic-alert",
    kind: r.kind,
    scope: valid?.scope ?? "instrument",
    params: valid?.params ?? r.params,
    title: "Synthetic alert",
    ...(r.malformed ? {} : { severity: "action", polarity: "negative" }),
    instrument: r.noInstrument ? null : inst,
  };
  const result = evaluateAlert(definition, {
    asOf: f.AS_OF,
    bars: new Map([[inst.id, bars]]),
    maxPriceAgeDays: r.maxAge ?? 5,
    ctx,
    lang: r.lang,
  });
  const type =
    result.outcome.type === "fired"
      ? "Fired"
      : result.outcome.type === "not_fired"
        ? "NotFired"
        : "Skipped";
  expect({ type, outcome: outcome(result.outcome), value: encode(result.value) }).toEqual(expected);
});
it("documents native JSON integer normalization while PyPlain retains integral-float rejection", () => {
  expect(
    validateAlert("change_pct", { window_days: 2, threshold: 0.1 }, { hasInstrument: true }).params
      .window_days,
  ).toBe(2);
  expect(() =>
    validateAlert(
      "change_pct",
      new Map([
        ["window_days", 2],
        ["threshold", 0.1],
      ]),
      { hasInstrument: true },
    ),
  ).toThrow("must be a whole number");
  expect(
    validateAlert(
      "change_pct",
      new Map<string, PyPlain>([
        ["window_days", 2n],
        ["threshold", 0.1],
      ]),
      { hasInstrument: true },
    ).params.window_days,
  ).toBe(2);
});
