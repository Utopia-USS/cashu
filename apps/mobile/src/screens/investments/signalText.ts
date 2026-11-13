// How a signal reads on the phone. The kinds whose payload carries the facts get a catalog sentence with
// the instrument's name and the values in the device locale; every other kind keeps the engine's text
// (a free-form message with no structured facts to rebuild it from). Public prices and shares always
// show; the owner's own amounts (a drift, a cost, the cash, the monthly plan) follow incognito like
// every other amount. A strategy bucket is named by its generic label or "a bucket", never by its id
// (owner decision F7); the engine's own text, where it stays, goes through the same bucket and incognito
// rules as on the desktop (`safeText`).
import { Decimal, type IsoDate } from "@cashu/domain";
import { planLabel } from "@cashu/domain/investments";
import { expr } from "@cashu/domain/investments/rules";
import { inEveryLang, lang } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import { maskDigits } from "@cashu/ui-logic/core/incognito";
import { unnameBuckets } from "@cashu/ui-logic/investments/buckets";
import { bucketDisplayName } from "@cashu/ui-logic/investments/labels";
import { RELATION_LABEL } from "@cashu/ui-logic/investments/v2/research/logic.strings";
import { type DisplayEnv, MASK, moneyText } from "../today/display";
import { dayMonth } from "./format";
import { S } from "./signalText.strings";

/** The part of a store signal row the sentence reads. */
export interface SignalTextRow {
  readonly kind: string;
  readonly message: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Who the signal is about and the currencies its amounts are in. */
export interface SignalSubject {
  /** The instrument's display name ("" for a portfolio-wide signal). */
  readonly name: string;
  /** The instrument's trading currency, if known. */
  readonly currency: string | null;
  /** The portfolio's base currency (the contribution plan's amount), if known. */
  readonly baseCurrency: string | null;
}

/**
 * An engine message or an owner-written title made safe to show, as the desktop's
 * `hideAmount(unnameBuckets(text))`: no id of the owner's own bucket (F7), and its digits masked
 * while amounts are hidden (the text may carry the owner's amounts).
 */
export function safeText(text: string, env: DisplayEnv): string {
  const named = unnameBuckets(text);
  return env.privacy ? maskDigits(named) : named;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function decimal(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) ? Decimal.fromFloat(value) : null;
  if (typeof value !== "string") return null;
  try {
    return Decimal.parse(value);
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A public price (a close, a level, an average): never hidden. */
function price(value: Decimal, currency: string | null, locale: string): string {
  return formatDecimalValue(value.abs(), locale, currency === null ? {} : { currency }).text;
}

/**
 * The owner's own amount: masked (or in bananas) while amounts are hidden. `signed` keeps the sign
 * (a loss, an amount to buy), else the size alone.
 */
function own(
  value: Decimal,
  currency: string | null,
  env: DisplayEnv,
  options: { readonly fractionDigits?: number; readonly signed?: boolean } = {},
): string {
  const amount = options.signed === true ? value : value.abs();
  if (currency !== null) return moneyText(amount, currency, env, options);
  if (env.privacy) return MASK;
  return formatDecimalValue(amount, env.locale, options).text;
}

/** Drift and cash amounts read in whole units, as on the desktop. */
const WHOLE = { fractionDigits: 0 } as const;

/** A ratio as a percent with one decimal, or none for a whole percent (a limit of 5%). */
function pct(ratio: number, locale: string, trim = false): string {
  const value = Decimal.fromFloat(Math.abs(ratio));
  const whole = trim && Number.isInteger(Math.round(Math.abs(ratio) * 1e6) / 1e4);
  return formatDecimalValue(value, locale, { percent: true, fractionDigits: whole ? 0 : 1 }).text;
}

/** A plain number with a fixed count of fraction digits. */
function plain(value: number, locale: string, fractionDigits: number): string {
  return formatDecimalValue(Decimal.fromFloat(value), locale, { fractionDigits }).text;
}

// ---- custom rules and alerts

/** Amount metrics whose sign is the fact (a loss, an amount to buy or to sell). */
const SIGNED_AMOUNTS = new Set(["unrealized_value", "drift_value"]);

/** One measured value of a custom condition, formatted by its metric's unit. */
function customValue(
  label: string,
  value: unknown,
  subject: SignalSubject,
  env: DisplayEnv,
): string {
  if (value === null || value === undefined) return S.unknown;
  if (typeof value === "boolean") return value ? S.yes : S.no;
  const metric = label.split("(", 1)[0] ?? label;
  // The evaluated bucket: its generic label or "a bucket", never the owner's own id (F7).
  if (metric === "bucket_id") return bucketDisplayName(typeof value === "string" ? value : null);
  if (typeof value === "string" && decimal(value) === null) return value;
  const amount = decimal(value);
  if (amount === null) return String(value);
  const unit = expr.METRICS.get(metric)?.unit;
  switch (unit) {
    case expr.Unit.RATIO:
      return formatDecimalValue(amount, env.locale, { percent: true, fractionDigits: 1 }).text;
    case expr.Unit.PP:
      return `${formatDecimalValue(amount, env.locale, { fractionDigits: 1 }).text} pp`;
    case expr.Unit.AMOUNT:
      return own(amount, subject.baseCurrency, env, {
        fractionDigits: 0,
        signed: SIGNED_AMOUNTS.has(metric),
      });
    case expr.Unit.PRICE:
      return price(amount, subject.currency, env.locale);
    case expr.Unit.DAYS:
    case expr.Unit.COUNT:
      return formatDecimalValue(amount, env.locale, { fractionDigits: 0 }).text;
    default:
      return plain(amount.toFloat(), env.locale, 2);
  }
}

/**
 * A custom rule's or a custom alert's sentence, or null when the engine's text carries the owner's own
 * message (then that message is the better text) or the payload lacks the expression.
 */
function customText(row: SignalTextRow, subject: SignalSubject, env: DisplayEnv): string | null {
  const p = row.payload;
  const when = str(p.when);
  if (when === null) return null;
  // The engine writes "Condition met" only when the owner gave the rule no message of its own.
  if (!inEveryLang(() => S.conditionMet).some((t) => row.message.includes(t))) return null;
  const bucket = str(p.bucket_id);
  const who =
    bucket !== null ? bucketDisplayName(bucket) : p.scope === "instrument" ? subject.name : "";
  const values =
    p.values !== null && typeof p.values === "object"
      ? Object.entries(p.values as Record<string, unknown>)
          .map(
            ([label, value]) =>
              `${unnameBuckets(label)}: ${customValue(label, value, subject, env)}`,
          )
          .join(", ")
      : "";
  return S.custom(who, unnameBuckets(when), values);
}

// ---- research and plan checks

/** A note's relation to the thesis in the desktop's words (none / neutral: no words). */
function relationWords(relation: unknown): string | null {
  switch (relation) {
    case "supports":
    case "weakens":
    case "invalidates":
    case "fulfills":
      return RELATION_LABEL[relation];
    default:
      return null;
  }
}

function planText(row: SignalTextRow, subject: SignalSubject, env: DisplayEnv): string | null {
  const p = row.payload;
  const name = subject.name || str(p.symbol);
  if (name === null) return null;
  if (row.kind === "plan:plan_no_exit") {
    if (p.trigger === "fulfilled") return S.noExitFulfilled(name);
    // The check fires only on a fulfilled thesis or a gain (domain plan/checks.ts).
    const unrealized = num(p.unrealized);
    if (unrealized === null || unrealized < 0) return null;
    return S.noExitUp(name, pct(unrealized, env.locale, true));
  }
  if (row.kind === "plan:plan_vs_thesis") {
    const plan = planLabel(str(p.plan), { held: true, lang: lang() });
    if (plan === null) return null;
    if (p.health === "weakened") return S.planWeakened(name, plan);
    if (p.health === "invalidated") return S.planInvalidated(name, plan);
  }
  return null;
}

// ---- the sentence

export function signalText(row: SignalTextRow, subject: SignalSubject, env: DisplayEnv): string {
  return sentenceOf(row, subject, env) ?? safeText(row.message, env);
}

/** The catalog sentence of a signal, or null when its payload does not carry the facts. */
function sentenceOf(row: SignalTextRow, subject: SignalSubject, env: DisplayEnv): string | null {
  const { locale } = env;
  const p = row.payload;
  const currency = str(p.currency) ?? subject.currency;
  const bucket = str(p.bucket_id);
  switch (row.kind) {
    case "alert:change_pct": {
      const change = num(p.change);
      const days = num(p.window_days);
      const from = decimal(p.from_close);
      const to = decimal(p.close);
      if (change === null || days === null || from === null || to === null) break;
      return (change < 0 ? S.fell : S.rose)(
        subject.name,
        pct(change, locale),
        days,
        price(from, currency, locale),
        price(to, currency, locale),
      );
    }
    case "drawdown_from_high":
    case "alert:drawdown_from_high": {
      const drawdown = num(p.drawdown);
      const days = num(p.window_days);
      const high = decimal(p.high_close ?? p.high);
      const last = decimal(p.last_close ?? p.close);
      if (drawdown === null || days === null || high === null || last === null) break;
      return S.drawdown(
        subject.name,
        pct(drawdown, locale),
        days,
        price(high, currency, locale),
        price(last, currency, locale),
      );
    }
    case "alert:price_above":
    case "alert:price_below": {
      const level = decimal(p.level);
      const close = decimal(p.close);
      if (level === null || close === null) break;
      return (row.kind === "alert:price_above" ? S.priceAbove : S.priceBelow)(
        subject.name,
        price(level, currency, locale),
        price(close, currency, locale),
      );
    }
    case "loss_from_cost":
    case "gain_from_cost": {
      const result = num(p.unrealized_pct);
      const cost = decimal(p.cost_basis_base);
      const value = decimal(p.market_value_base);
      if (result === null || cost === null || value === null) break;
      return (result < 0 ? S.lossFromCost : S.gainFromCost)(
        subject.name,
        pct(result, locale),
        own(cost, currency, env),
        own(value, currency, env),
      );
    }
    case "position_concentration": {
      const weight = num(p.weight);
      const limit = num(p.max_weight);
      if (weight === null || limit === null) break;
      return S.concentration(subject.name, pct(weight, locale), pct(limit, locale, true));
    }
    case "allocation_drift": {
      const weight = num(p.weight);
      const target = num(p.target);
      const drift = num(p.drift_pp);
      const amount = decimal(p.drift_value_base);
      if (weight === null || target === null || drift === null || amount === null) break;
      return (drift > 0 ? S.driftOver : S.driftUnder)(
        bucketDisplayName(bucket),
        pct(weight, locale),
        pct(target, locale, true),
        own(amount, currency ?? subject.baseCurrency, env, WHOLE),
      );
    }
    case "alert:weight_above":
    case "alert:weight_below": {
      const weight = num(p.weight);
      const threshold = num(p.threshold);
      if (weight === null || threshold === null) break;
      const above = row.kind === "alert:weight_above";
      if (bucket !== null)
        return (above ? S.bucketWeightAbove : S.bucketWeightBelow)(
          bucketDisplayName(bucket),
          pct(weight, locale),
          pct(threshold, locale, true),
        );
      if (subject.name === "") break;
      return (above ? S.weightAbove : S.weightBelow)(
        subject.name,
        pct(weight, locale),
        pct(threshold, locale, true),
      );
    }
    case "contribution_gap": {
      const amount = decimal(p.monthly_amount);
      if (amount === null) break;
      const whole = amount.toFloat() === Math.trunc(amount.toFloat());
      // Without the base currency (the portfolio not read yet) the amount reads as a plain number.
      const plan = own(amount, subject.baseCurrency, env, { fractionDigits: whole ? 0 : 2 });
      const day = num(p.day_of_month);
      const days = num(p.days_since_last_deposit);
      const last = str(p.last_deposit);
      if (days === null || last === null) return S.noContributions(plan, day);
      return S.contributionGap(days, dayMonth(last as IsoDate, locale), plan, day);
    }
    case "cash_level": {
      const weight = num(p.cash_weight);
      const cash = decimal(p.cash_base);
      const below = p.direction === "below_min";
      const threshold = num(below ? p.min_weight : p.max_weight);
      if (weight === null || cash === null || threshold === null) break;
      return (below ? S.cashBelow : S.cashAbove)(
        pct(weight, locale),
        own(cash, currency ?? subject.baseCurrency, env, WHOLE),
        pct(threshold, locale, true),
      );
    }
    case "tagged_weight": {
      const weight = num(p.weight);
      const limit = num(p.max_weight);
      const tags = Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string") : [];
      const labels = Array.isArray(p.instruments)
        ? p.instruments.filter((t) => typeof t === "string")
        : [];
      if (weight === null || limit === null || tags.length === 0) break;
      return S.taggedWeight(tags, pct(weight, locale), pct(limit, locale, true), labels.join(", "));
    }
    case "alert:new_high": {
      const days = num(p.window_days);
      const close = decimal(p.close);
      const previous = decimal(p.previous_high);
      if (subject.name === "" || days === null || close === null || previous === null) break;
      return S.newHigh(
        subject.name,
        days,
        price(close, currency, locale),
        price(previous, currency, locale),
      );
    }
    case "alert:sma_cross": {
      const days = num(p.window_days);
      const close = decimal(p.close);
      const sma = decimal(p.sma);
      if (subject.name === "" || days === null || close === null || sma === null) break;
      if (p.direction !== "above" && p.direction !== "below") break;
      return (p.direction === "above" ? S.smaAbove : S.smaBelow)(
        subject.name,
        days,
        price(close, currency, locale),
        price(sma, currency, locale),
      );
    }
    case "alert:range_breakout": {
      const days = num(p.window_days);
      const breakout = num(p.breakout_pct);
      if (subject.name === "" || days === null || breakout === null) break;
      const edge = decimal(breakout >= 0 ? p.range_high : p.range_low);
      if (edge === null) break;
      return (breakout >= 0 ? S.breakoutUp : S.breakoutDown)(
        subject.name,
        days,
        pct(breakout, locale),
        price(edge, currency, locale),
      );
    }
    case "alert:volume_spike": {
      const days = num(p.window_days);
      const ratio = num(p.ratio);
      if (subject.name === "" || days === null || ratio === null) break;
      return S.volumeSpike(subject.name, plain(ratio, locale, 1), days);
    }
    case "custom":
    case "alert:custom":
      return customText(row, subject, env);
    case "plan:plan_no_exit":
    case "plan:plan_vs_thesis":
      return planText(row, subject, env);
  }
  if (row.kind.startsWith("research:")) {
    const title = str(p.title);
    const strength = num(p.strength);
    const sources = num(p.sources);
    if (title !== null && strength !== null && sources !== null)
      return S.research(title, relationWords(p.relation ?? p.thesis_relation), strength, sources);
  }
  return null;
}
