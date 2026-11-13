// How a signal reads on the phone. The kinds whose payload carries the facts get a catalog sentence with
// the instrument's name and the values in the device locale; every other kind keeps the engine's text
// (a free-form message with no structured facts to rebuild it from).
import { Decimal } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { S } from "./signalText.strings";

/** The part of a store signal row the sentence reads. */
export interface SignalTextRow {
  readonly kind: string;
  readonly message: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Who the signal is about: the instrument's display name and its trading currency, if known. */
export interface SignalSubject {
  readonly name: string;
  readonly currency: string | null;
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

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function money(value: Decimal, currency: string | null, locale: string): string {
  return formatDecimalValue(value.abs(), locale, currency === null ? {} : { currency }).text;
}

/** A ratio as a percent with one decimal, or none for a whole percent (a limit of 5%). */
function pct(ratio: number, locale: string, trim = false): string {
  const value = Decimal.fromFloat(Math.abs(ratio));
  const whole = trim && Number.isInteger(Math.round(Math.abs(ratio) * 1e6) / 1e4);
  return formatDecimalValue(value, locale, { percent: true, fractionDigits: whole ? 0 : 1 }).text;
}

export function signalText(row: SignalTextRow, subject: SignalSubject, locale: string): string {
  const p = row.payload;
  const currency = str(p.currency) ?? subject.currency;
  const bucket = str(p.bucket_id);
  const who = bucket === null ? subject.name : S.bucket(bucket);
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
        money(from, currency, locale),
        money(to, currency, locale),
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
        money(high, currency, locale),
        money(last, currency, locale),
      );
    }
    case "alert:price_above":
    case "alert:price_below": {
      const level = decimal(p.level);
      const close = decimal(p.close);
      if (level === null || close === null) break;
      return (row.kind === "alert:price_above" ? S.priceAbove : S.priceBelow)(
        subject.name,
        money(level, currency, locale),
        money(close, currency, locale),
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
        money(cost, currency, locale),
        money(value, currency, locale),
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
      if (
        bucket === null ||
        weight === null ||
        target === null ||
        drift === null ||
        amount === null
      )
        break;
      return (drift > 0 ? S.driftOver : S.driftUnder)(
        who,
        pct(weight, locale),
        pct(target, locale, true),
        money(amount, currency, locale),
      );
    }
    case "alert:weight_above":
    case "alert:weight_below": {
      const weight = num(p.weight);
      const threshold = num(p.threshold);
      if (who === "" || weight === null || threshold === null) break;
      return (row.kind === "alert:weight_above" ? S.weightAbove : S.weightBelow)(
        who,
        pct(weight, locale),
        pct(threshold, locale, true),
      );
    }
    case "contribution_gap": {
      const period = num(p.period_days);
      if (period === null) break;
      const days = num(p.days_since_last_deposit);
      return days === null ? S.noDeposits(period) : S.contributionGap(days, period);
    }
    case "cash_level": {
      const weight = num(p.cash_weight);
      const cash = decimal(p.cash_base);
      const below = p.direction === "below_min";
      const threshold = num(below ? p.min_weight : p.max_weight);
      if (weight === null || cash === null || threshold === null) break;
      return (below ? S.cashBelow : S.cashAbove)(
        pct(weight, locale),
        money(cash, currency, locale),
        pct(threshold, locale, true),
      );
    }
  }
  return row.message;
}
