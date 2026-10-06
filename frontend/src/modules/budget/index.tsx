import type { ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { FactList, Kpi } from "../../ui";
import { BankSync } from "./BankSync";
import { Expenses } from "./Expenses";
import { Flows } from "./Flows";
import { monthLabel } from "./logic";
import { Subscriptions } from "./Subscriptions";

// The overview's `summary.month` is in the profile's base currency (the server's budget default).

export const budget: ModuleDef = {
  id: "budget",
  name: "Budżet domowy",
  desc: "Konta, wydatki, przepływy, subskrypcje · CSV lub Open Banking",
  short: "Konta bankowe, wydatki po kategoriach, przepływy i subskrypcje",
  tabs: [
    { id: "expenses", label: "Wydatki", render: (ctx) => <Expenses categories={ctx.categories} onDataChanged={ctx.refresh} /> },
    { id: "flows", label: "Przepływy", render: () => <Flows /> },
    { id: "subs", label: "Subskrypcje", render: () => <Subscriptions /> },
  ],
  TabAction: BankSync,
  Kpis: ({ ctx }) => {
    const m = ctx.summary.month;
    if (ctx.state === "empty" || !m) return null;
    const c = ctx.profile.base_currency;
    return (
      <Kpi
        label={`Wynik ${m.label}`}
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
        ...(m ? [[`Wydatki ${monthLabel(m.label)}`, cur(m.expense, ctx.profile.base_currency)] as [string, string]] : []),
        ["Subskrypcje", subs?.count ? `${subs.count}${totals ? ` · ${totals} / mies` : ""}` : "brak"],
        ["Ostatnie dane", asof ?? "-"],
      ]} />
    );
  },
};
