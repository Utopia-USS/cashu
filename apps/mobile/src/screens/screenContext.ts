import { type Decimal, type IsoDate, ZERO } from "@cashu/domain";
import type { BudgetScreenPeriod } from "@cashu/store/budget/queries";
import type { PeriodChoice } from "./money-contracts";

/** Calendar day on this device, rather than the UTC day of an ISO timestamp. */
export function localToday(now = new Date()): IsoDate {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function budgetPeriod(choice: PeriodChoice): BudgetScreenPeriod {
  switch (choice.kind) {
    case "all":
      return {};
    case "year":
      return { year: choice.year };
    case "quarter":
      return { year: choice.year, quarter: choice.quarter };
    case "month":
      return { year: choice.year, month: choice.month };
  }
}

/** Dimensionless geometry. Exact Decimals remain the only source of displayed money. */
export function plotRatios(values: readonly Decimal[]): number[] {
  const scale = values.reduce((max, value) => {
    const magnitude = value.abs();
    return magnitude.compare(max) > 0 ? magnitude : max;
  }, ZERO);
  return scale.isZero()
    ? values.map(() => 0)
    : values.map((value) => Number(value.div(scale).toString()));
}
