// ContributionsWidget (ab24ab6 v2/Perf.tsx:132-160), the light grid's Wpłaty: this year's deposits against the plan,
// the next deposit, the 12-month bars with the plan line. Every text is formatted here; the View lays it out.
import { S } from "@cashu/i18n/investments/v2/Perf.strings";
import type { BarChartProps, FactProps } from "@cashu/ui";
import { dm, money0 } from "@cashu/ui-logic/investments/labels";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import { contributionFacts, monthlyFlows } from "@cashu/ui-logic/investments/v2/logic";
import type { Performance } from "@cashu/ui-logic/investments/v2/types";

export interface ContributionsWidgetProps {
  title: string;
  count: string;
  /** Null = the old Skeleton (the 12-month read has not answered). */
  body: null | {
    facts: FactProps[];
    chart: BarChartProps | null;
    empty: string;
  };
}

export function contributionsProps(input: {
  perf: Performance | null | undefined;
  ytd: Performance | null | undefined;
  plan: { amount: number; day: number | null } | null;
  today: string;
  /** The budget module is on: the next deposit comes from the budget surplus. */
  fromBudget: boolean;
}): ContributionsWidgetProps {
  const { perf, ytd, plan, today } = input;
  const c = perf?.base_currency ?? ytd?.base_currency ?? "PLN";
  const months = monthlyFlows(perf?.points ?? [], today, 12);
  const curDone = (months[months.length - 1]?.value ?? 0) > 0;
  // The plan counts from January or from the first deposit, whichever is later (shared with the hero's Wpłaty).
  const firstFlow = (perf?.points ?? []).find((p) => (p.flow ?? 0) > 0)?.date ?? null;
  const { deposits, planYtd, missed } = contributionFacts({
    months,
    deposits: ytd?.summary?.deposits ?? null,
    plan,
    firstDeposit: firstFlow,
    today,
  });
  const next = nextDeposit(today, plan?.day ?? null);
  const showChart = (!!perf && months.some((m) => m.value > 0)) || !!plan;
  return {
    title: S.contributions,
    count: S.months12,
    body:
      perf === undefined
        ? null
        : {
            facts: [
              {
                label: S.thisYear,
                value: deposits != null ? money0(deposits, c) : "-",
                detail:
                  planYtd != null
                    ? `${S.plan(money0(planYtd, c))}${missed ? S.missed(missed) : ""}`
                    : S.noPlan,
              },
              {
                label: S.next,
                value: dm(
                  curDone ? nextDeposit(`${today.slice(0, 8)}31`, plan?.day ?? null) : next,
                ),
                ...(plan
                  ? {
                      detail: `${money0(plan.amount, c)} ${input.fromBudget ? S.fromBudget : S.byPlan}`,
                    }
                  : {}),
              },
            ],
            chart: showChart
              ? {
                  label: S.contributionsChartLabel,
                  height: 120,
                  values: months.map((m) => m.value),
                  labels: months.map((m) => m.label),
                  kinds: months.map((m, i) =>
                    i === months.length - 1 && !m.value && plan ? "plan" : "main",
                  ),
                  plan: plan?.amount ?? null,
                  ...(plan ? { planLabel: S.plan(money0(plan.amount, c)) } : {}),
                  valueKind: "amount",
                }
              : null,
            empty: S.noContributions,
          },
  };
}
