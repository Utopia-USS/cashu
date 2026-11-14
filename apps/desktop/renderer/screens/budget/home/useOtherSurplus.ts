// One other currency's surplus over the shown period, for the hero's "Też w EUR: ..." link. A hook per
// currency (each reads its own cash flow; the screen hook started every one of them with its other reads).
import type { IsoDate } from "@cashu/domain";
import { S as H } from "@cashu/i18n/budget/BudgetHome.strings";
import { budgetScreenCashflow } from "@cashu/store/budget/queries";
import { useQuery } from "@cashu/store-react";
import { cur } from "@cashu/ui-logic/core/format";
import { monthIndex, type PeriodMode, periodSurplus } from "./budgetHomeModel.js";
import type { OtherSurplusState } from "./budgetHomeState.js";

export function useOtherSurplus(args: {
  currency: string;
  mode: PeriodMode;
  anchor: number;
  today: IsoDate;
  pick(currency: string): void;
}): OtherSurplusState | null {
  const { currency, today } = args;
  const flow = useQuery(budgetScreenCashflow, { today, currency, period: {} });
  const surplus = periodSurplus(
    flow.rows.map((r) => ({ i: monthIndex(r.label), income: r.income, expense: r.expense })),
    args.mode,
    args.anchor,
    monthIndex(today),
  );
  if (surplus.isZero()) return null;
  return {
    currency,
    lead: H.alsoIn(currency),
    value: `${surplus.isSigned() ? "" : "+"}${cur(surplus.toFloat(), currency)}`,
    title: H.showCurrency(currency),
    onPress: () => args.pick(currency),
  };
}
