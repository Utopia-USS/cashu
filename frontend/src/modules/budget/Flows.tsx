import { useState } from "react";
import { Bar, Line, Tooltip } from "recharts";
import { ScrollableChart } from "../../components/ScrollableChart";
import { useShell } from "../../core/context";
import { cssVar, cur, cur0 } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import type { CashflowRow } from "./api";
import { getCashflow } from "./api";
import { CurrencySwitch, useBudgetCurrency } from "./currency";
import { MonthCloseCard } from "./MonthClose";
import { S } from "./Flows.strings.ts";

type Gran = "monthly" | "quarterly" | "yearly";

// Window measured in periods of the current granularity.
const ranges = (gran: Gran): [string, number | null][] => ({
  monthly: [["6M", 6], ["12M", 12], ["24M", 24], [S.max, null]] as [string, number | null][],
  quarterly: [[S.oneYear, 4], [S.years(2), 8], [S.years(3), 12], [S.max, null]] as [string, number | null][],
  yearly: [[S.years(3), 3], [S.years(5), 5], [S.years(10), 10], [S.max, null]] as [string, number | null][],
})[gran];
const DEFAULT_RANGE: Record<Gran, number | null> = { monthly: 12, quarterly: 8, yearly: null };

function aggregate(rows: CashflowRow[], gran: Gran): CashflowRow[] {
  if (gran === "monthly") return rows;
  const out = new Map<string, CashflowRow>();
  for (const r of rows) {
    const [y, mo] = r.label.split("-").map(Number);
    const key = gran === "yearly" ? `${y}` : `${y} Q${Math.floor((mo - 1) / 3) + 1}`;
    const cur = out.get(key) ?? { label: key, income: 0, expense: 0, net: 0 };
    cur.income += r.income;
    cur.expense += r.expense;
    cur.net += r.net;
    out.set(key, cur);
  }
  return [...out.values()];
}

export function Flows() {
  const { slug, profile } = useShell();
  const bc = useBudgetCurrency();
  const currency = bc.currency;
  const shown = currency ?? profile.base_currency;
  // The rows carry their currency, so the title and axis never label one currency's numbers with
  // another while a switch is loading.
  const { data: loaded } = useAsync(
    () => (bc.ready ? getCashflow(slug, 240, currency).then((rows) => ({ cur: shown, rows })) : Promise.resolve(null)),
    [slug, bc.ready, currency],
    { key: bc.ready ? ck(slug, "budget", "flows", currency) : undefined },
  );
  const data = loaded?.rows;
  const dataCur = loaded?.cur ?? shown;
  const [gran, setGran] = useState<Gran>("monthly");
  const rows = aggregate(data ?? [], gran);
  const yValues = rows.flatMap((r) => [r.income, r.expense, r.net]).concat(0);

  const controls = (
    <>
    <CurrencySwitch bc={bc} />
    <select value={gran} onChange={(e) => setGran(e.target.value as Gran)} title={S.aggregation}>
      <option value="monthly">{S.monthly}</option>
      <option value="quarterly">{S.quarterly}</option>
      <option value="yearly">{S.yearly}</option>
    </select>
    </>
  );

  return (
    <>
    <MonthCloseCard bc={bc} />
    <ScrollableChart
      key={`${gran}:${dataCur}`}
      title={S.title(dataCur)}
      controls={controls}
      data={rows}
      yValues={yValues}
      xAxisProps={{ dataKey: "label", type: "category", minTickGap: 20 }}
      ranges={ranges(gran)}
      fullSpan={rows.length}
      defaultRange={DEFAULT_RANGE[gran]}
      yTickFormatter={(v) => cur0(v, dataCur)}
      tooltip={
        <Tooltip
          contentStyle={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 13 }}
          formatter={(v, name) => [cur(v as number, dataCur), name as string] as [string, string]}
        />
      }
    >
      {/* Static like the net line (and every other chart mark): an animated Bar
          interpolates from the previous layout (first render uses a 320px fallback
          width, then every range/resize change), so bars and line drift apart and
          stay apart whenever animation frames are throttled. */}
      <Bar dataKey="income" name={S.income} fill={cssVar("--pos")} isAnimationActive={false} />
      <Bar dataKey="expense" name={S.expenses} fill={cssVar("--neg")} isAnimationActive={false} />
      <Line type="monotone" dataKey="net" name={S.net} stroke={cssVar("--net")} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
    </ScrollableChart>
    </>
  );
}
