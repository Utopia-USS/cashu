import { type Decimal, ZERO } from "@cashu/domain";
import type { BudgetScreenPeriod } from "@cashu/store/budget/screen";
import type { PeriodChoice } from "./money-contracts";

export { localToday } from "../format/calendar";

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
