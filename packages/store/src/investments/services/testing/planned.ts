// Test support: the Python dict shape of `month_plan` (snake_case keys), amounts as 2-place
// decimal strings, so the plan tests compare against Python's values.
import { type Decimal, format2 } from "@cashu/domain";
import type { MonthPlan } from "../planned.js";

/** Python `_money`: rounded to 2 places (half even), as a decimal string; null stays null. */
const money = (value: Decimal | null): string | null => (value === null ? null : format2(value));

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
