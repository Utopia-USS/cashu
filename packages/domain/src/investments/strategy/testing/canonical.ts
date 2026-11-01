// A `StrategyLoadResult` in the golden form of parity/python/canon.py (dataclass field names, sets
// sorted by their JSON text, tuples as lists, Decimals as `str()`, NaN / infinities as strings), as
// `JSON.parse` reads the rows of parity/python/vectors_inv_strategy.py. Test-only.

import type { BucketMatch } from "../../domain/buckets.js";
import type { CompiledExpression } from "../../rules/expr/compiled.js";
import type { ExprNode } from "../../rules/expr/nodes.js";
import type { RuleSpec } from "../../rules/kind.js";
import type { AllocationDriftParams } from "../../rules/kinds/allocationDrift.js";
import type { CashLevelParams } from "../../rules/kinds/cashLevel.js";
import type { ContributionGapParams } from "../../rules/kinds/contributionGap.js";
import type { CustomParams } from "../../rules/kinds/custom.js";
import type { DrawdownFromHighParams } from "../../rules/kinds/drawdownFromHigh.js";
import type { PositionConcentrationParams } from "../../rules/kinds/positionConcentration.js";
import type { InstrumentFilter } from "../../rules/kinds/support.js";
import type { TaggedWeightParams } from "../../rules/kinds/taggedWeight.js";
import type { UnrealizedThresholdParams } from "../../rules/kinds/unrealizedFromCost.js";
import type { StrategyConfig } from "../config.js";
import type { InactiveRule, StrategyIssue, StrategyLoadResult } from "../issues.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Python `json.dumps(s, ensure_ascii=False)` of a string (the sort key canon.py uses for sets). */
function jsonText(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function byCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** A Python set of strings as canon.py writes it. */
function sortedSet(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => byCodePoints(jsonText(a), jsonText(b)));
}

function float(x: number): Json {
  if (Number.isNaN(x)) return "NaN";
  if (x === Number.POSITIVE_INFINITY) return "Infinity";
  if (x === Number.NEGATIVE_INFINITY) return "-Infinity";
  return x;
}

function issue(i: StrategyIssue): Json {
  return {
    severity: i.severity,
    path: i.path,
    message: i.message,
    line: i.line,
    column: i.column,
    code: i.code,
    params: { ...i.params },
  };
}

function inactive(r: InactiveRule): Json {
  return {
    index: r.index,
    rule_id: r.ruleId,
    kind: r.kind,
    line: r.line,
    issues: r.issues.map(issue),
  };
}

function match(m: BucketMatch): Json {
  return {
    asset_classes: sortedSet(m.assetClasses),
    tags: sortedSet(m.tags),
    mics: sortedSet(m.mics),
    currencies: sortedSet(m.currencies),
    instrument_ids: sortedSet(m.instrumentIds),
  };
}

function filter(f: InstrumentFilter): Json {
  return {
    asset_classes: sortedSet(f.assetClasses),
    tags: [...f.tags],
    instrument_ids: sortedSet(f.instrumentIds),
  };
}

function node(n: ExprNode): Json {
  switch (n.type) {
    case "Number":
      return { value: n.value.toString(), text: n.text, column: n.column };
    case "String":
    case "Boolean":
      return { value: n.value, column: n.column };
    case "Name":
      return { name: n.name, column: n.column };
    case "Call":
      return { name: n.name, args: n.args.map(node), column: n.column };
    case "Unary":
      return { op: n.op, operand: node(n.operand), column: n.column };
    case "Binary":
    case "Compare":
      return { op: n.op, left: node(n.left), right: node(n.right), column: n.column };
    case "Logical":
      return { op: n.op, operands: n.operands.map(node), column: n.column };
  }
}

function expression(e: CompiledExpression | null): Json {
  if (e === null) return null;
  return {
    source: e.source,
    scope: e.scope,
    tree: node(e.tree),
    metrics: e.metrics.map((m) => ({ name: m.name, args: [...m.args], column: m.column })),
  };
}

/** The params dataclass of a built-in kind, by kind name. */
function params(spec: RuleSpec): Json {
  switch (spec.kind) {
    case "allocation_drift": {
      const p = spec.params as AllocationDriftParams;
      return {
        bands: {
          absolute_band_pp: float(p.bands.absoluteBandPp),
          relative_band: float(p.bands.relativeBand),
          min_trade_value: p.bands.minTradeValue.toString(),
        },
        buckets: [...p.buckets],
      };
    }
    case "position_concentration": {
      const p = spec.params as PositionConcentrationParams;
      return { max_weight: float(p.maxWeight), filter: filter(p.filter) };
    }
    case "loss_from_cost":
    case "gain_from_cost": {
      const p = spec.params as UnrealizedThresholdParams;
      return { threshold: float(p.threshold), filter: filter(p.filter) };
    }
    case "drawdown_from_high": {
      const p = spec.params as DrawdownFromHighParams;
      return { threshold: float(p.threshold), window_days: p.windowDays, filter: filter(p.filter) };
    }
    case "cash_level": {
      const p = spec.params as CashLevelParams;
      return {
        min_weight: p.minWeight === null ? null : float(p.minWeight),
        max_weight: p.maxWeight === null ? null : float(p.maxWeight),
      };
    }
    case "contribution_gap": {
      const p = spec.params as ContributionGapParams;
      return { period_days: p.periodDays, grace_days: p.graceDays };
    }
    case "tagged_weight": {
      const p = spec.params as TaggedWeightParams;
      return { tags: [...p.tags], max_weight: float(p.maxWeight) };
    }
    case "custom": {
      const p = spec.params as CustomParams;
      return {
        expression: expression(p.expression),
        scope: p.scope,
        message: p.message,
        filter: filter(p.filter),
        buckets: [...p.buckets],
      };
    }
    default:
      throw new Error(`no canonical form for params of ${spec.kind}`);
  }
}

function config(c: StrategyConfig | null): Json {
  if (c === null) return null;
  const targets: Record<string, Json> = {};
  for (const [k, v] of c.allocation.targets) targets[k] = float(v);
  const watch: Record<string, Json> = {};
  for (const [k, v] of c.watchlist.values) watch[k] = float(v);
  return {
    version: c.version,
    base_currency: c.baseCurrency,
    allocation: {
      buckets: c.allocation.buckets.map((b) => ({ id: b.id, match: match(b.match) })),
      targets,
    },
    horizon_years: c.horizonYears,
    rebalance: {
      absolute_band_pp: float(c.rebalance.absoluteBandPp),
      relative_band: float(c.rebalance.relativeBand),
      min_trade_value: c.rebalance.minTradeValue.toString(),
    },
    data: {
      max_price_age_days: c.data.maxPriceAgeDays,
      max_stale_weight: float(c.data.maxStaleWeight),
      max_unclassified_weight: float(c.data.maxUnclassifiedWeight),
      max_fx_age_days: c.data.maxFxAgeDays,
      max_unverified_days: c.data.maxUnverifiedDays,
    },
    contributions:
      c.contributions === null
        ? null
        : {
            monthly_amount: c.contributions.monthlyAmount.toString(),
            day_of_month: c.contributions.dayOfMonth,
          },
    rules: c.rules.map((r) => ({
      id: r.id,
      kind: r.kind,
      params: params(r),
      severity: r.severity,
      cooldown_days: r.cooldownDays,
      polarity: r.polarity,
    })),
    watchlist: { values: watch },
    benchmark: c.benchmark === null ? null : { ...c.benchmark },
    notifications: {
      immediate: sortedSet(c.notifications.immediate),
      digest_weekday: c.notifications.digestWeekday,
    },
    review: {
      every: c.review.every,
      day: c.review.day,
      name: c.review.name,
      cards: [...c.review.cards],
    },
    markdown: c.markdown,
  };
}

export function resultOut(result: StrategyLoadResult): Json {
  return {
    config: config(result.config),
    issues: result.issues.map(issue),
    partial: config(result.partial),
    inactive_rules: result.inactiveRules.map(inactive),
  };
}

/** `json` with every object's keys sorted, as the vectors are written (`sort_keys=True`). */
export function sortKeys(json: Json): Json {
  if (Array.isArray(json)) return json.map(sortKeys);
  if (json === null || typeof json !== "object") return json;
  const obj = json as { readonly [key: string]: Json };
  const out: Record<string, Json> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key] as Json);
  return out;
}
