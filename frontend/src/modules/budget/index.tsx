import type { ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { FactList, Kpi } from "../../ui";
import { BudgetActions } from "./BankSync";
import { Expenses } from "./Expenses";
import { Flows } from "./Flows";
import { monthLabel } from "./logic";
import { BudgetStart } from "./Start";
import { Subscriptions } from "./Subscriptions";
import { S } from "./index.strings.ts";

// The overview's `summary.month` is in the profile's base currency (the server's budget default).

export const budget: ModuleDef = {
  id: "budget",
  get name() { return S.name; },
  get desc() { return S.desc; },
  get short() { return S.short; },
  tabs: [
    { id: "expenses", get label() { return S.tabExpenses; }, render: (ctx) => <Expenses categories={ctx.categories} onDataChanged={ctx.refresh} /> },
    { id: "flows", get label() { return S.tabFlows; }, render: () => <Flows /> },
    { id: "subs", get label() { return S.tabSubs; }, render: () => <Subscriptions /> },
  ],
  Start: BudgetStart,
  TabAction: BudgetActions,
  Kpis: ({ ctx }) => {
    const m = ctx.summary.month;
    if (ctx.state === "empty" || !m) return null;
    const c = ctx.profile.base_currency;
    return (
      <Kpi
        label={S.kpiResult(m.label)}
        value={cur(m.net, c)}
        hint={`+${cur(m.income, c)} / -${cur(m.expense, c)}`}
        cls={m.net < 0 ? "neg" : "pos"}
      />
    );
  },
  Facts: ({ ctx }) => {
    const m = ctx.summary.month;
    const subs = ctx.summary.subscriptions;
    const totals = Object.entries(subs?.monthly_totals ?? {}).map(([c, v]) => `~${cur(v, c)}`).join(" · ");
    const asof = ctx.networth.accounts
      .filter((a) => a.bank !== "manual" && a.type !== "cash")
      .map((a) => a.as_of).filter(Boolean).sort().slice(-1)[0];
    return (
      <FactList facts={[
        ...(m ? [[S.factExpenses(monthLabel(m.label)), cur(m.expense, ctx.profile.base_currency)] as [string, string]] : []),
        [S.factSubs, subs?.count ? `${subs.count}${totals ? ` · ${totals}${S.perMonth}` : ""}` : S.none],
        [S.factLastData, asof ?? "-"],
      ]} />
    );
  },
};
