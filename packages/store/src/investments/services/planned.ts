// The month's contribution-plan progress (Python `service/planned.py:month_plan`): a pure read over
// this vault's view plus injected inputs. The strategy comes in as the usable config (the caller's
// strategy loader, `usableConfig`); FX rates come from the device's price cache (device-local, never
// in the view: events.md 10), the PORT this read takes, as `performance/inputs.ts` does.
import { addDays, type Decimal, daysInMonth, format2, pyStrip, sum, ZERO } from "@cashu/domain";
import {
  type Currency,
  convert,
  InMemoryFxLookup,
  market,
  preloadRates,
  toCurrency,
} from "@cashu/domain/investments";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import { profileOf } from "../../core/queries.js";
import { brokerageDeposits, plannedDeposits } from "../queries/planned.js";
import type { Read } from "../queries/shared.js";

/** Days before the month whose rates are preloaded (a weekend or holiday at the start). */
const FX_MARGIN_DAYS = 10;

export interface MonthPlanRequest {
  /** `YYYY-MM`; the month of `today` when absent. */
  readonly month?: string | null;
  /** Today's date (the caller's clock). */
  readonly today: string;
  /** The usable strategy config (`usableConfig`), null without a strategy. */
  readonly strategy: StrategyConfig | null;
  /** The device's price cache (PLN rates). */
  readonly prices: market.PriceCache;
}

export interface MonthPlan {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The base currency every amount is in. */
  readonly currency: Currency;
  /** The strategy's `contributions.monthly_amount`, null without a plan. */
  readonly monthlyAmount: Decimal | null;
  readonly dayOfMonth: number | null;
  /** Deposits dated in the month (trade-date FX), null when a rate is missing. */
  readonly deposited: Decimal | null;
  /** Open plans dated in the month (FX of the planned date or the newest known), null on a gap. */
  readonly planned: Decimal | null;
  readonly remaining: Decimal | null;
  readonly covered: boolean | null;
  readonly plannedCount: number;
}

export type MonthPlanResult =
  | { readonly ok: true; readonly value: MonthPlan }
  | { readonly ok: false; readonly reason: "invalid_month" };

/** The later of two ISO dates (string order is date order). */
function laterDate(a: string, b: string): string {
  if (b > a) return b;
  return a;
}

/** The earlier of two ISO dates. */
function earlierDate(a: string, b: string): string {
  if (b < a) return b;
  return a;
}

/** Python `int(text)` for the month parts: optional sign, ASCII digits, single underscores. */
function pyInt(text: string): number | null {
  const t = pyStrip(text);
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) return null;
  return Number(t.replaceAll("_", ""));
}

/** Python `_month_bounds`: the first and last day of `month` (`YYYY-MM`), else of `today`'s month. */
function monthBounds(
  month: string | null | undefined,
  today: string,
): { start: string; end: string } | null {
  let year: number;
  let number: number;
  if (month == null) {
    year = Number(today.slice(0, 4));
    number = Number(today.slice(5, 7));
  } else {
    const dash = month.indexOf("-");
    if (dash < 0) return null;
    const y = pyInt(month.slice(0, dash));
    const m = pyInt(month.slice(dash + 1));
    if (y === null || m === null || !(m >= 1 && m <= 12) || !(y >= 1900 && y <= 9999)) return null;
    year = y;
    number = m;
  }
  const ym = `${String(year).padStart(4, "0")}-${String(number).padStart(2, "0")}`;
  return {
    start: `${ym}-01`,
    end: `${ym}-${String(daysInMonth(year, number)).padStart(2, "0")}`,
  };
}

/**
 * Python `month_plan`: the month's contribution-plan progress in the base currency (the strategy's,
 * else the profile's): the strategy's `monthly_amount`, deposits dated in the month, open plans dated
 * in the month, what remains and whether the plan is covered. Unrounded values; `monthPlanRecord`
 * renders the Python dict.
 */
export function monthPlan(read: Read, request: MonthPlanRequest): MonthPlanResult {
  const bounds = monthBounds(request.month, request.today);
  if (bounds === null) return { ok: false, reason: "invalid_month" };
  const { start, end } = bounds;
  const { today, strategy } = request;
  const base =
    strategy !== null ? strategy.baseCurrency : toCurrency(profileOf(read)?.baseCurrency ?? "PLN");
  const plan = strategy?.contributions ?? null;
  const deposits = brokerageDeposits(read, start, end);
  const plans = plannedDeposits(read, ["planned"]).filter(
    (p) => start <= p.plannedDate && p.plannedDate <= end,
  );
  const currencies = new Set<Currency>([base]);
  for (const t of deposits) currencies.add(toCurrency(t.cashCurrency));
  for (const p of plans) currencies.add(toCurrency(p.currency));
  const until = laterDate(end, today);
  const cached = market.cachedMarketData(request.prices, []);
  const rates = [...currencies].flatMap((c) => cached.fxRates(c));
  const fx = new InMemoryFxLookup(
    preloadRates(rates, currencies, until, addDays(start, -FX_MARGIN_DAYS)),
  );

  const total = (items: readonly [Decimal, string, string][]): Decimal | null => {
    const converted: Decimal[] = [];
    for (const [amount, currency, on] of items) {
      const value = convert(fx, amount, toCurrency(currency), base, on);
      if (value === null) return null;
      converted.push(value);
    }
    return sum(converted);
  };

  const deposited = total(deposits.map((t) => [t.cashAmount, t.cashCurrency, t.tradeDate]));
  const planned = total(
    plans.map((p) => [p.amount, p.currency, earlierDate(p.plannedDate, today)]),
  );
  const monthly = plan?.monthlyAmount ?? null;
  let remaining: Decimal | null = null;
  let covered: boolean | null = null;
  if (monthly !== null && deposited !== null && planned !== null) {
    const left = monthly.sub(deposited).sub(planned);
    remaining = left.gt(ZERO) ? left : ZERO;
    covered = remaining.isZero();
  }
  return {
    ok: true,
    value: {
      month: start.slice(0, 7),
      currency: base,
      monthlyAmount: monthly,
      dayOfMonth: plan?.dayOfMonth ?? null,
      deposited,
      planned,
      remaining,
      covered,
      plannedCount: plans.length,
    },
  };
}

/** Python `_money`: rounded to 2 places (half even), as a decimal string; null stays null. */
const money = (value: Decimal | null): string | null => (value === null ? null : format2(value));

/** The Python dict shape of `month_plan` (snake_case keys), amounts as 2-place decimal strings. */
export function monthPlanRecord(
  plan: MonthPlan,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    month: plan.month,
    currency: plan.currency,
    monthly_amount: money(plan.monthlyAmount),
    day_of_month: plan.dayOfMonth,
    deposited: money(plan.deposited),
    planned: money(plan.planned),
    remaining: money(plan.remaining),
    covered: plan.covered,
    planned_count: plan.plannedCount,
  };
}
