/**
 * The fixed metric catalog of custom-rule expressions (`rules/expr/catalog.py`): names, argument specs,
 * types, units, scopes.
 *
 * Only names listed here exist in an expression; there is no other way to reach data or code.
 * EXPRESSIONS.md documents the same catalog for users. Order and texts match Python exactly (the
 * order is the documentation order and the order of did-you-mean candidates).
 */

import { ASSET_CLASSES } from "../../domain/enums.js";
import { InvariantError } from "../../domain/values.js";
import { type ArgSpec, type MetricSpec, SCOPES, Scope, Unit, ValueType } from "./catalogTypes.js";
import { MAX_FUNCTION_ARGS, MAX_WINDOW_DAYS } from "./limits.js";

function arg(name: string, type: ValueType, extra: Partial<ArgSpec> = {}): ArgSpec {
  return Object.freeze({
    name,
    type,
    minimum: null,
    maximum: null,
    choices: null,
    reference: null,
    variadic: false,
    ...extra,
  });
}

function metric(
  name: string,
  type: ValueType,
  unit: Unit,
  scopes: ReadonlySet<Scope>,
  doc: string,
  extra: { readonly args?: readonly ArgSpec[]; readonly choices?: readonly string[] } = {},
): MetricSpec {
  return Object.freeze({
    name,
    type,
    unit,
    scopes,
    doc,
    args: extra.args ?? null,
    choices: extra.choices ?? null,
  });
}

const ALL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);
const INSTRUMENT: ReadonlySet<Scope> = new Set([Scope.INSTRUMENT]);
const BUCKET: ReadonlySet<Scope> = new Set([Scope.BUCKET]);
const INSTRUMENT_OR_BUCKET: ReadonlySet<Scope> = new Set([Scope.INSTRUMENT, Scope.BUCKET]);

/** Wire names of every asset class, in declaration order. */
export const ASSET_CLASS_NAMES: readonly string[] = Object.freeze([...ASSET_CLASSES]);

const WINDOW = arg("window_days", ValueType.NUMBER, { minimum: 2, maximum: MAX_WINDOW_DAYS });
const BUCKET_ARG = arg("bucket", ValueType.TEXT, { reference: "bucket" });

const { NUMBER, BOOLEAN, TEXT } = ValueType;

const SPECS: readonly MetricSpec[] = Object.freeze([
  // --- portfolio metrics (every scope) -------------------------------------------------------
  metric(
    "total_value",
    NUMBER,
    Unit.AMOUNT,
    ALL_SCOPES,
    "Portfolio value in the base currency (holdings + cash).",
  ),
  metric(
    "cash_value",
    NUMBER,
    Unit.AMOUNT,
    ALL_SCOPES,
    "Cash balances plus cash-like instruments (asset_class cash), base currency.",
  ),
  metric(
    "cash_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "cash_value / total_value (same definition as the cash_level rule).",
  ),
  metric(
    "stale_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Share of the portfolio valued with stale prices.",
  ),
  metric(
    "unclassified_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Share of the portfolio in holdings that match no strategy bucket.",
  ),
  metric(
    "max_position_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Weight of the largest instrument position (cash-like instruments excluded).",
  ),
  metric(
    "holdings_count",
    NUMBER,
    Unit.COUNT,
    ALL_SCOPES,
    "Number of distinct instruments held (cash-like instruments excluded).",
  ),
  metric(
    "days_since_last_deposit",
    NUMBER,
    Unit.DAYS,
    ALL_SCOPES,
    "Calendar days since the newest deposit in any account.",
  ),
  metric(
    "monthly_contribution",
    NUMBER,
    Unit.AMOUNT,
    ALL_SCOPES,
    "contributions.monthly_amount from the strategy.",
  ),
  metric("bucket_weight", NUMBER, Unit.RATIO, ALL_SCOPES, "Current weight of a bucket.", {
    args: [BUCKET_ARG],
  }),
  metric(
    "bucket_target",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Target weight of a bucket (allocation.targets).",
    { args: [BUCKET_ARG] },
  ),
  metric(
    "bucket_drift_pp",
    NUMBER,
    Unit.PP,
    ALL_SCOPES,
    "Bucket weight minus target in percentage points (positive = overweight).",
    { args: [BUCKET_ARG] },
  ),
  metric(
    "bucket_value",
    NUMBER,
    Unit.AMOUNT,
    ALL_SCOPES,
    "Value of a bucket in the base currency.",
    { args: [BUCKET_ARG] },
  ),
  metric(
    "tagged_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Summed weight of holdings that carry ALL the given tags.",
    { args: [arg("tag", TEXT, { variadic: true })] },
  ),
  metric(
    "asset_class_weight",
    NUMBER,
    Unit.RATIO,
    ALL_SCOPES,
    "Summed weight of holdings of one asset class (cash also counts cash balances).",
    { args: [arg("asset_class", TEXT, { choices: ASSET_CLASS_NAMES })] },
  ),
  // --- instrument scope ----------------------------------------------------------------------
  metric(
    "symbol",
    TEXT,
    Unit.TEXT,
    INSTRUMENT,
    "Ticker symbol (or the name when there is no symbol).",
  ),
  metric("asset_class", TEXT, Unit.TEXT, INSTRUMENT, 'Asset class wire name, e.g. "etf".', {
    choices: ASSET_CLASS_NAMES,
  }),
  metric("currency", TEXT, Unit.TEXT, INSTRUMENT, 'Trading currency, e.g. "USD".'),
  metric("mic", TEXT, Unit.TEXT, INSTRUMENT, 'Exchange code, e.g. "XWAR".'),
  metric(
    "weight",
    NUMBER,
    Unit.RATIO,
    INSTRUMENT_OR_BUCKET,
    "Instrument scope: the instrument's weight across accounts. Bucket scope: the bucket's weight.",
  ),
  metric(
    "market_value",
    NUMBER,
    Unit.AMOUNT,
    INSTRUMENT,
    "Market value across accounts, base currency.",
  ),
  metric(
    "cost_basis",
    NUMBER,
    Unit.AMOUNT,
    INSTRUMENT,
    "Cost basis across accounts, base currency at trade-date FX.",
  ),
  metric(
    "unrealized_pct",
    NUMBER,
    Unit.RATIO,
    INSTRUMENT,
    "(market_value - cost_basis) / cost_basis; -0.25 = down 25% from cost.",
  ),
  metric(
    "unrealized_value",
    NUMBER,
    Unit.AMOUNT,
    INSTRUMENT,
    "market_value - cost_basis, base currency.",
  ),
  metric(
    "last_close",
    NUMBER,
    Unit.PRICE,
    INSTRUMENT,
    "Newest close in the instrument's currency.",
  ),
  metric(
    "drawdown_from_high",
    NUMBER,
    Unit.RATIO,
    INSTRUMENT,
    "1 - last close / highest close of the last window_days bars (0.15 = 15% below the high).",
    { args: [WINDOW] },
  ),
  metric(
    "price_change",
    NUMBER,
    Unit.RATIO,
    INSTRUMENT,
    "last close / first close of the last window_days bars - 1 (0.1 = up 10%).",
    { args: [WINDOW] },
  ),
  metric(
    "price_vs_sma",
    NUMBER,
    Unit.RATIO,
    INSTRUMENT,
    "last close / average close of the last window_days bars - 1 (negative = below the average).",
    { args: [WINDOW] },
  ),
  metric(
    "holding_has_tag",
    BOOLEAN,
    Unit.FLAG,
    INSTRUMENT,
    "True when the instrument carries the tag.",
    { args: [arg("tag", TEXT)] },
  ),
  // --- bucket scope --------------------------------------------------------------------------
  metric("bucket_id", TEXT, Unit.TEXT, BUCKET, "Id of the bucket being evaluated."),
  metric("target", NUMBER, Unit.RATIO, BUCKET, "Target weight of the bucket."),
  metric(
    "drift_pp",
    NUMBER,
    Unit.PP,
    BUCKET,
    "weight - target in percentage points (positive = overweight).",
  ),
  metric(
    "drift_rel",
    NUMBER,
    Unit.RATIO,
    BUCKET,
    "(weight - target) / target; unknown when the target is 0.",
  ),
  metric("value", NUMBER, Unit.AMOUNT, BUCKET, "Bucket value, base currency."),
  metric(
    "drift_value",
    NUMBER,
    Unit.AMOUNT,
    BUCKET,
    "value - target x total_value: positive = above target (to sell), negative = to buy.",
  ),
]);

/** Every metric by name, in documentation order (a Map: names such as `constructor` stay plain keys). */
export const METRICS: ReadonlyMap<string, MetricSpec> = new Map(
  SPECS.map((spec) => [spec.name, spec]),
);

// The catalog invariants Python asserts at import time.
if (METRICS.size !== SPECS.length) throw new InvariantError("duplicate metric names");
if (SPECS.some((spec) => spec.args !== null && spec.args.length > MAX_FUNCTION_ARGS)) {
  throw new InvariantError("too many declared arguments");
}

/** Metric names usable in `scope`, in documentation order. */
export function namesInScope(scope: Scope): string[] {
  return SPECS.filter((spec) => spec.scopes.has(scope)).map((spec) => spec.name);
}
