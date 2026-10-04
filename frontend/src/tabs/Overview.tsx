import type { Category, NetworthResp, Summary } from "../api";
import { Accounts } from "../components/Accounts";
import { Breakdown } from "../components/Breakdown";
import { CashCard } from "../components/CashCard";
import { NetWorthChart } from "../components/NetWorthChart";
import { cur } from "../format";
import { Kpi } from "../ui";

export function Overview({
  summary, networth, categories, onRefresh,
}: {
  summary: Summary;
  networth: NetworthResp;
  categories: Category[];
  onRefresh: () => void;
}) {
  const bd = summary.breakdown;
  const m = summary.month;
  const subs = summary.subscriptions;
  const others = Object.entries(summary.networth)
    .filter(([c]) => c !== "PLN")
    .filter(([, v]) => Math.abs(v) > 0.005)
    .map(([c, v]) => cur(v, c))
    .join(" · ");
  const hasHome = bd.property || bd.mortgage;
  const subsTotals = Object.entries(subs?.monthly_totals ?? {}).map(([c, v]) => `~${cur(v, c)}`).join(" · ");

  return (
    <>
      <div className="kpis">
        <Kpi label="Net worth (PLN)" value={cur(bd.net)} hint={others} />
        <Kpi label="Aktywa" value={cur(bd.assets)} cls="pos" />
        <Kpi label="Zobowiązania" value={cur(-bd.liabilities)} cls={bd.liabilities > 0 ? "neg" : ""} />
        <Kpi
          label="Home equity"
          value={hasHome ? cur(bd.home_equity) : "—"}
          hint={hasHome ? "nieruchomość − hipoteka" : "dodaj: finanse add-position"}
        />
        <Kpi
          label={`Wynik ${m ? m.label : ""}`}
          value={m ? cur(m.net) : "—"}
          hint={m ? `+${cur(m.income)} / −${cur(m.expense)}` : ""}
          cls={m && m.net < 0 ? "neg" : "pos"}
        />
        <Kpi
          label="Subskrypcje"
          value={subs ? subs.count : 0}
          hint={subsTotals ? `${subsTotals} / mies` : ""}
        />
      </div>

      <NetWorthChart />
      <Breakdown bd={bd} />
      <Accounts accounts={networth.accounts} />
      <CashCard categories={categories} onChanged={onRefresh} />
    </>
  );
}
