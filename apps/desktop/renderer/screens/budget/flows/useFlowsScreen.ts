// The Przepływy tab (ab24ab6 modules/budget/Flows.tsx): the native monthly cash flow of the chosen budget
// currency, aggregated per month / quarter / year, the visible range from the route.
import type { IsoDate } from "@cashu/domain";
import { S } from "@cashu/i18n/budget/Flows.strings";
import { budgetScreenCashflow } from "@cashu/store/budget/queries";
import { useQuery } from "@cashu/store-react";
import { cur, cur0 } from "@cashu/ui-logic/core/format";
import { useBudgetCurrency } from "../expenses/budgetCurrency.js";
import { aggregate, DEFAULT_RANGE, type Gran, ranges } from "./flowsModel.js";

export interface FlowsFilters {
  currency?: string;
  gran?: Gran;
  /** Visible periods; 0 = Max (everything, no scroll). */
  range?: number;
  month?: string;
}

export function useFlowsScreen(args: {
  today: IsoDate;
  filters: FlowsFilters;
  onFilters(next: FlowsFilters): void;
}) {
  const f = args.filters;
  const patch = (values: Partial<FlowsFilters>) => args.onFilters({ ...f, ...values });
  const bc = useBudgetCurrency({
    today: args.today,
    requested: f.currency,
    onChange: (currency) => patch({ currency }),
  });
  const flow = useQuery(budgetScreenCashflow, {
    today: args.today,
    currency: bc.currency,
    period: {},
  });
  const c = flow.currency;
  const gran: Gran = f.gran ?? "monthly";
  const rows = aggregate(
    flow.rows.slice(-240).map((r) => ({
      label: r.label,
      income: r.income.toFloat(),
      expense: r.expense.toFloat(),
      net: r.net.toFloat(),
    })),
    gran,
  );
  const range = f.range === undefined ? DEFAULT_RANGE[gran] : f.range === 0 ? null : f.range;
  const tip = (i: number) => {
    const r = rows[i];
    return {
      title: r?.label ?? "",
      rows: r
        ? [
            { name: S.income, value: cur(r.income, c), amount: true },
            { name: S.expenses, value: cur(r.expense, c), amount: true },
            { name: S.net, value: cur(r.net, c), amount: true },
          ]
        : [],
    };
  };
  return {
    bc,
    month: f.month ?? null,
    onMonth: (month: string | null) => patch({ month: month ?? undefined }),
    today: args.today,
    title: S.title(c),
    gran,
    granOptions: (["monthly", "quarterly", "yearly"] as const).map((value) => ({
      value,
      label: S[value],
    })),
    onGran: (next: string) => patch({ gran: next as Gran, range: undefined }),
    ranges: ranges(gran),
    range,
    onRange: (next: number | null) => patch({ range: next ?? 0 }),
    labels: rows.map((r) => r.label),
    bars: [
      { name: S.income, values: rows.map((r) => r.income), color: "positive" as const },
      { name: S.expenses, values: rows.map((r) => r.expense), color: "negative" as const },
    ],
    line: { name: S.net, values: rows.map((r) => r.net), color: "net" as const },
    yFormat: (v: number) => cur0(v, c),
    tooltip: tip,
    summary: rows
      .map((_, i) => {
        const t = tip(i);
        return `${t.title}: ${t.rows.map((r) => `${r.name} ${r.value}`).join(", ")}`;
      })
      .join("; "),
  };
}
export type FlowsScreenState = ReturnType<typeof useFlowsScreen>;
