// The light grid's Wpłaty widget (ab24ab6 v2/Home.tsx wContrib + fallbackPlan): the strategy's contribution plan,
// else this month's planned deposit, else the last deposit; `z nadwyżki budżetu` while the budget module is on.
// Mounted only on the light grid, so its two reads (the planned deposits and the module states) cost nothing
// on the full grid.
import { lang } from "@cashu/i18n";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { planForMonth } from "@cashu/ui-logic/investments/v2/logic";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";
import { type ContributionsWidgetProps, contributionsProps } from "./contributionsModel.js";

const overview = overviewQueries({ prices: null });

export function useContributionsWidget(data: InvestmentsHomeData): ContributionsWidgetProps {
  const today = data.ov.data?.as_of ?? data.today;
  const modules = useQuery(overview.moduleStates);
  const widgets = useQuery(overview.investments, { today: data.today, lang: lang() });
  const contributions = data.strat.data?.facts?.contributions;
  const plan =
    contributions?.monthly_amount != null
      ? { amount: contributions.monthly_amount, day: contributions.day_of_month ?? null }
      : null;
  const perf = data.perf1y.data;
  // Old fallbackPlan: this month's planned deposit, else the last deposit as the plan. The native read lists the
  // open plans only (booked ones are not listed, O.md gap).
  const fallback = () => {
    const planned =
      widgets.status === "available"
        ? widgets.openPlans.map((p, i) => ({
            id: i + 1,
            planned_date: p.plannedDate,
            status: "planned",
            amount: p.amount.toFloat(),
          }))
        : null;
    const local = planForMonth(planned, today.slice(0, 7));
    if (local) return { amount: local.amount, day: Number(local.planned_date.slice(8, 10)) };
    const flows = (perf?.points ?? []).filter((p) => (p.flow ?? 0) > 0);
    const last = flows[flows.length - 1];
    return last ? { amount: last.flow ?? 0, day: Number(last.date.slice(8, 10)) } : null;
  };
  return contributionsProps({
    perf,
    ytd: data.perfYtd.data,
    plan: plan ?? fallback(),
    today,
    fromBudget: modules.some((m) => m.id === "budget" && m.enabled),
  });
}
