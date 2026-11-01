/**
 * Producer of `investments.strategy_loader` (`parity/python/checks/investments.py`): per profile with
 * the investments module the strategy state (state, digest, changed, read error, newest stored
 * version, the whole load result), plus the load result of every shipped template, written like
 * canon.py writes the Python dataclasses (field names, sets sorted by their JSON text, Decimals as
 * `str()`, floats as Python floats).
 */

import type { investments as inv } from "@cashu/domain";
import type {
  AllocationDriftParams,
  CashLevelParams,
  ContributionGapParams,
  CustomParams,
  DrawdownFromHighParams,
  expr,
  InstrumentFilter,
  PositionConcentrationParams,
  RuleSpec,
  TaggedWeightParams,
  UnrealizedThresholdParams,
} from "@cashu/domain/investments/rules";
import {
  type InactiveRule,
  loadStrategy,
  STRATEGY_TEMPLATE_NAMES,
  type StrategyConfig,
  type StrategyIssue,
  type StrategyLoadResult,
  strategyTemplate,
} from "@cashu/domain/investments/strategy";
import type { PythonDb } from "../../sources/index.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { Serializer } from "./serialize.ts";
import { profileStrategy } from "./strategy.ts";

const MODULE = "investments";

/** canon.py `_as_row_id` on a text value. */
function isRowId(value: string): boolean {
  return /^[0-9]+$/.test(value) && !value.startsWith("0");
}

/** Python `json.dumps(s, ensure_ascii=False)`: canon.py sorts sets by this text. */
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

function sortedSet(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => byCodePoints(jsonText(a), jsonText(b)));
}

function int(n: number | null): OutValue {
  return n === null ? null : BigInt(n);
}

class StrategyOut {
  private readonly ids: Serializer;

  constructor(db: PythonDb) {
    this.ids = new Serializer(db);
  }

  /** An `id` / `rule_id` field: canon.py has no table for it, so a row id there fails the golden. */
  private plainId(field: string, value: string | null): OutValue {
    if (value !== null && isRowId(value)) throw new Error(`unmapped id in field ${field}`);
    return value;
  }

  /** An `instrument_ids` set: row ids become instrument natural keys, as canon.py maps them. */
  private instrumentIds(ids: Iterable<string>): OutValue {
    return sortedSet([...ids].map((id) => this.ids.instrumentKey(id)));
  }

  private issue(i: StrategyIssue): OutValue {
    return {
      severity: i.severity,
      path: i.path,
      message: i.message,
      line: int(i.line),
      column: int(i.column),
      code: i.code,
      params: { ...i.params },
    };
  }

  private inactive(r: InactiveRule): OutValue {
    return {
      index: BigInt(r.index),
      rule_id: this.plainId("rule_id", r.ruleId),
      kind: r.kind,
      line: int(r.line),
      issues: r.issues.map((i) => this.issue(i)),
    };
  }

  private filter(f: InstrumentFilter): OutValue {
    return {
      asset_classes: sortedSet(f.assetClasses),
      tags: [...f.tags],
      instrument_ids: this.instrumentIds(f.instrumentIds),
    };
  }

  private node(n: expr.ExprNode): OutValue {
    const column = BigInt(n.column);
    switch (n.type) {
      case "Number":
        return { value: n.value, text: n.text, column };
      case "String":
      case "Boolean":
        return { value: n.value, column };
      case "Name":
        return { name: n.name, column };
      case "Call":
        return { name: n.name, args: n.args.map((a) => this.node(a)), column };
      case "Unary":
        return { op: n.op, operand: this.node(n.operand), column };
      case "Binary":
      case "Compare":
        return { op: n.op, left: this.node(n.left), right: this.node(n.right), column };
      case "Logical":
        return { op: n.op, operands: n.operands.map((o) => this.node(o)), column };
    }
  }

  private expression(e: expr.CompiledExpression | null): OutValue {
    if (e === null) return null;
    return {
      source: e.source,
      scope: e.scope,
      tree: this.node(e.tree),
      metrics: e.metrics.map((m) => ({
        name: m.name,
        args: m.args.map((a) => (typeof a === "number" ? BigInt(a) : a)),
        column: BigInt(m.column),
      })),
    };
  }

  /** The params dataclass of a built-in kind. */
  private params(spec: RuleSpec): OutValue {
    switch (spec.kind) {
      case "allocation_drift": {
        const p = spec.params as AllocationDriftParams;
        return {
          bands: {
            absolute_band_pp: pyFloat(p.bands.absoluteBandPp),
            relative_band: pyFloat(p.bands.relativeBand),
            min_trade_value: p.bands.minTradeValue,
          },
          buckets: [...p.buckets],
        };
      }
      case "position_concentration": {
        const p = spec.params as PositionConcentrationParams;
        return { max_weight: pyFloat(p.maxWeight), filter: this.filter(p.filter) };
      }
      case "loss_from_cost":
      case "gain_from_cost": {
        const p = spec.params as UnrealizedThresholdParams;
        return { threshold: pyFloat(p.threshold), filter: this.filter(p.filter) };
      }
      case "drawdown_from_high": {
        const p = spec.params as DrawdownFromHighParams;
        return {
          threshold: pyFloat(p.threshold),
          window_days: BigInt(p.windowDays),
          filter: this.filter(p.filter),
        };
      }
      case "cash_level": {
        const p = spec.params as CashLevelParams;
        return {
          min_weight: p.minWeight === null ? null : pyFloat(p.minWeight),
          max_weight: p.maxWeight === null ? null : pyFloat(p.maxWeight),
        };
      }
      case "contribution_gap": {
        const p = spec.params as ContributionGapParams;
        return { period_days: BigInt(p.periodDays), grace_days: BigInt(p.graceDays) };
      }
      case "tagged_weight": {
        const p = spec.params as TaggedWeightParams;
        return { tags: [...p.tags], max_weight: pyFloat(p.maxWeight) };
      }
      case "custom": {
        const p = spec.params as CustomParams;
        return {
          expression: this.expression(p.expression),
          scope: p.scope,
          message: p.message,
          filter: this.filter(p.filter),
          buckets: [...p.buckets],
        };
      }
      default:
        throw new Error(`no canonical form for the params of rule kind ${spec.kind}`);
    }
  }

  private match(m: inv.BucketMatch): OutValue {
    return {
      asset_classes: sortedSet(m.assetClasses),
      tags: sortedSet(m.tags),
      mics: sortedSet(m.mics),
      currencies: sortedSet(m.currencies),
      instrument_ids: this.instrumentIds(m.instrumentIds),
    };
  }

  config(c: StrategyConfig | null): OutValue {
    if (c === null) return null;
    const targets: Record<string, OutValue> = {};
    for (const [k, v] of c.allocation.targets) targets[k] = pyFloat(v);
    const watch: Record<string, OutValue> = {};
    for (const [k, v] of c.watchlist.values) watch[k] = pyFloat(v);
    return {
      version: BigInt(c.version),
      base_currency: c.baseCurrency,
      allocation: {
        buckets: c.allocation.buckets.map((b) => ({
          id: this.plainId("id", b.id),
          match: this.match(b.match),
        })),
        targets,
      },
      horizon_years: int(c.horizonYears),
      rebalance: {
        absolute_band_pp: pyFloat(c.rebalance.absoluteBandPp),
        relative_band: pyFloat(c.rebalance.relativeBand),
        min_trade_value: c.rebalance.minTradeValue,
      },
      data: {
        max_price_age_days: BigInt(c.data.maxPriceAgeDays),
        max_stale_weight: pyFloat(c.data.maxStaleWeight),
        max_unclassified_weight: pyFloat(c.data.maxUnclassifiedWeight),
        max_fx_age_days: BigInt(c.data.maxFxAgeDays),
        max_unverified_days: int(c.data.maxUnverifiedDays),
      },
      contributions:
        c.contributions === null
          ? null
          : {
              monthly_amount: c.contributions.monthlyAmount,
              day_of_month: int(c.contributions.dayOfMonth),
            },
      rules: c.rules.map((r) => ({
        id: this.plainId("id", r.id),
        kind: r.kind,
        params: this.params(r),
        severity: r.severity,
        cooldown_days: int(r.cooldownDays),
        polarity: r.polarity,
      })),
      watchlist: { values: watch },
      benchmark:
        c.benchmark === null
          ? null
          : {
              id: this.plainId("id", c.benchmark.id),
              proxy: c.benchmark.proxy,
              currency: c.benchmark.currency,
            },
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

  result(r: StrategyLoadResult | null): OutValue {
    if (r === null) return null;
    return {
      config: this.config(r.config),
      issues: r.issues.map((i) => this.issue(i)),
      partial: this.config(r.partial),
      inactive_rules: r.inactiveRules.map((i) => this.inactive(i)),
    };
  }
}

export function produceStrategyLoader(db: PythonDb): OutValue {
  const s = new StrategyOut(db);
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes(MODULE)) continue;
    const st = profileStrategy(db, p);
    out[db.keys.key("profiles", p.id)] = {
      state: st.state,
      sha256: st.sha256,
      changed: st.changed,
      read_error: st.readError,
      version: st.latest === null ? null : BigInt(st.latest.version),
      result: s.result(st.result),
    };
  }
  // the templates folder sorted by file name (`sorted(folder.glob("*.yaml"))`)
  const templates: Record<string, OutValue> = {};
  for (const name of [...STRATEGY_TEMPLATE_NAMES].sort()) {
    const template = strategyTemplate(name);
    if (template === null) continue;
    templates[name] = s.result(loadStrategy(template.yaml, template.markdown));
  }
  out.templates = templates;
  return out;
}
