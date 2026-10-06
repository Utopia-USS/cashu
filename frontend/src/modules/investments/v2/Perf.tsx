// Portfolio charts (F-03, F-13; track PF): Wartość vs benchmark (the same cash flows into the benchmark,
// dashed; end labels with leaders; hover / keyboard tooltip; table view), Obsunięcie od szczytu (TWR index
// drawdown, clamped at 0) and Wpłaty (12 months of deposits vs the plan, the next one and its source).
import { useState } from "react";
import { Bars, LineChart } from "../../../charts";
import { labelIndices } from "../../../chart";
import { GROUP, monthYearShort } from "../../../format";
import { useAsync } from "../../../hooks";
import { Seg, Skeleton } from "../../../ui";
import { Facts, FootFacts, Widget } from "../../../widgets";
import { dm, money0, pct, plural, pp } from "../labels";
import { nextDeposit } from "../logic";
import { accKey, getPerformance, invKey, type Performance, type PerfRange } from "./api";
import { benchmarkLabel, contributionFacts, daysSince, monthlyFlows, staleBenchmark } from "./logic";

const RANGES: [string, PerfRange][] = [["1M", "1m"], ["3M", "3m"], ["YTD", "ytd"], ["1R", "1y"], ["3R", "3y"], ["Max", "max"]];
const RANGE_TEXT: Record<PerfRange, string> = { "1m": "1 mies.", "3m": "3 mies.", ytd: "od początku roku", "1y": "12 mies.", "3y": "3 lata", max: "całość" };
const dateLong = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });
const axisK = (v: number) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0, ...GROUP }).format(Math.round(v / 1000) * 1000);

const BENCH_NOTE: Record<string, string> = {
  no_strategy: "benchmark: brak strategii", not_configured: "benchmark: ustaw benchmark.proxy w strategii",
  proxy_not_found: "benchmark: nie znaleziono instrumentu", no_prices: "benchmark: brak notowań (cashu invest backfill)",
};

export function ValueChartWidget({ slug, accounts, initial, nonce = 0 }: {
  slug: string; accounts: number[] | null; initial?: Performance | null;
  /** The page's reload counter: a reload (run, import, decision) re-reads the shown range (F7 FE7). */
  nonce?: number;
}) {
  const [range, setRange] = useState<PerfRange>("1y");
  const [table, setTable] = useState(false);
  // `initial` (Home's 1y series) is in the deps too: a reloaded 1y series replaces the shown one.
  // Keyed like Home's series (same request): a range Home already read (1y, ytd, 1m) shows at once (F7 PX4).
  const q = useAsync(() => (range === "1y" && initial !== undefined ? Promise.resolve(initial) : getPerformance(slug, range, accounts)),
    [slug, range, accounts?.join(","), nonce, range === "1y" ? initial : null], { key: invKey(slug, "perf", range, accKey(accounts)) });
  const perf = q.data;
  const pts = perf?.points ?? [];
  const bench = perf?.benchmark;
  const benchOk = bench?.status === "ok";
  const c = perf?.base_currency ?? "PLN";
  const s = perf?.summary;
  const lastV = pts.length ? pts[pts.length - 1].value : null;
  const lastB = pts.length ? pts[pts.length - 1].simulated_value : null;
  const benchName = benchmarkLabel(bench);
  // What the backend says about the figures (incomplete days, implied funding, stale benchmark), F7 FE13.
  const xl = labelIndices(pts.length, 5).map((i) => ({ i, text: range === "1m" ? dm(pts[i].date) : monthYearShort(pts[i].date) }));
  const tip = (i: number) => {
    const p = pts[i];
    const diff = p.twr != null && p.benchmark != null ? (p.twr - p.benchmark) * 100 : null;
    return (
      <>
        <div className="k">{dateLong(p.date)}</div>
        <div>portfel <b>{money0(p.value, c)}</b></div>
        {benchOk && p.simulated_value != null && <div>{benchName} <b>{money0(p.simulated_value, c)}</b></div>}
        {benchOk && diff != null && <div className="k">różnica <b>{pp(diff)}</b></div>}
      </>
    );
  };
  return (
    <Widget title="Wartość vs benchmark" id="inv-value"
      controls={<Seg quiet label="Zakres" value={range} onChange={setRange} items={RANGES} />}
      body="tight"
      footer={s ? (
        <>
          <FootFacts items={[
            <>{RANGE_TEXT[range]} TWR <b>{pct(s.twr, true)}</b></>,
            // A benchmark whose prices stop early: the short label instead of its figure (F4; FE-A A1 sweep).
            benchOk && staleBenchmark(bench) && <span title={staleBenchmark(bench)!.title}>{staleBenchmark(bench)!.label}</span>,
            benchOk && !staleBenchmark(bench) && bench?.twr != null && <>benchmark <b>{pct(bench.twr, true)}</b></>,
            benchOk && !staleBenchmark(bench) && bench?.excess_twr != null && <>różnica <b className={bench.excess_twr >= 0 ? "pos" : "neg"}>{pp(bench.excess_twr * 100)}</b></>,
            s.xirr != null && <>XIRR <b>{pct(s.xirr)}</b></>,
            s.net_contributions != null && <>wpłaty {RANGE_TEXT[range]} <b>{money0(s.net_contributions, c)}</b></>,
            !benchOk && bench && (BENCH_NOTE[bench.status] ?? "benchmark niedostępny"),
          ]} />
          <span className="spacer" /><button className="lnk" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? "wykres" : "tabela"}</button>
        </>
      ) : undefined}>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i className="main" />portfel</span>
        {benchOk && <span><i className="bench" />{benchName} w {c}, te same wpłaty</span>}
      </div>
      {q.loading && !perf ? <Skeleton h={230} /> : !perf || pts.length < 2 ? (
        <div className="empty">{perf === null ? <>Brak historii: uruchom <code>cashu invest backfill</code>.</> : "Za mało historii."}</div>
      ) : table ? (
        <div className="ctable">
          <table>
            <thead><tr><th>Data</th><th className="num">Portfel</th>{benchOk && <th className="num">{benchName}</th>}<th className="num">TWR</th>{benchOk && <th className="num">Różnica</th>}</tr></thead>
            <tbody>
              {labelIndices(pts.length, 13).map((i) => pts[i]).map((p) => (
                <tr key={p.date}><td>{p.date}</td><td className="num">{money0(p.value, c)}</td>{benchOk && <td className="num">{money0(p.simulated_value, c)}</td>}
                  <td className="num">{pct(p.twr, true)}</td>{benchOk && <td className="num">{p.twr != null && p.benchmark != null ? pp((p.twr - p.benchmark) * 100) : "-"}</td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <LineChart label={`Wartość portfela${benchOk ? ` i ${benchName} przy tych samych wpłatach` : ""}, ${RANGE_TEXT[range]}`} height={230} padL={56} padR={150} yFmt={axisK} xLabels={xl}
          series={[
            ...(benchOk ? [{ values: pts.map((p) => p.simulated_value), cls: "bench" as const, endLabel: lastB != null ? `${benchName} ${money0(lastB, c)}` : undefined }] : []),
            { values: pts.map((p) => p.value), cls: "main" as const, area: true, endLabel: lastV != null ? `portfel ${money0(lastV, c)}` : undefined },
          ]}
          tooltip={tip} />
      )}
    </Widget>
  );
}

export function DrawdownWidget({ perf }: { perf: Performance | null | undefined }) {
  const pts = perf?.points ?? [];
  const md = perf?.summary?.max_drawdown;
  const now = pts.length ? pts[pts.length - 1].drawdown : null;
  const recoveredDays = md?.trough && md.recovered ? daysSince(md.trough, md.recovered) : null;
  const recovered = recoveredDays != null && recoveredDays >= 0 ? recoveredDays : null;
  const xl = labelIndices(pts.length, 3).map((i) => ({ i, text: monthYearShort(pts[i].date) }));
  return (
    <Widget title="Obsunięcie od szczytu" id="inv-dd" controls={<span className="tag">12 mies.</span>} body="tight">
      {perf === undefined ? <Skeleton h={150} /> : !pts.length ? <div className="empty">Brak historii.</div> : (
        <>
          <Facts style={{ marginBottom: 6 }} items={[
            { label: "Teraz", value: pct(now) },
            { label: "Maks.", value: pct(md?.depth ?? null), detail: md?.trough ? `${dm(md.trough)} · ${recovered != null ? `odrobione w ${plural(recovered, "dzień", "dni", "dni")}` : "jeszcze nieodrobione"}` : undefined },
          ]} />
          <LineChart label="Obsunięcie portfela od szczytu, 12 miesięcy" height={110} padL={40} padR={10} yTicks={2} ymax={0}
            yFmt={(v) => `${Math.round(v * 100)} %`} xLabels={xl} series={[{ values: pts.map((p) => p.drawdown), cls: "neg", area: true, areaTo: 0 }]} />
        </>
      )}
    </Widget>
  );
}

export function ContributionsWidget({ perf, ytd, plan, today, fromBudget }: {
  perf: Performance | null | undefined;
  ytd: Performance | null | undefined;
  plan: { amount: number; day: number | null } | null;
  today: string;
  fromBudget: boolean;
}) {
  const c = perf?.base_currency ?? ytd?.base_currency ?? "PLN";
  const months = monthlyFlows(perf?.points ?? [], today, 12);
  const curDone = months[months.length - 1]?.value > 0;
  // The plan counts from January or from the first deposit, whichever is later (a profile that started in
  // July has no "missed" months before it); shared with the hero's Wpłaty fact (home v3 Q19).
  const firstFlow = (perf?.points ?? []).find((p) => (p.flow ?? 0) > 0)?.date ?? null;
  const { deposits, planYtd, missed } = contributionFacts({ months, deposits: ytd?.summary?.deposits ?? null, plan, firstDeposit: firstFlow, today });
  const next = nextDeposit(today, plan?.day ?? null);
  return (
    <Widget title="Wpłaty" id="inv-contrib" controls={<span className="tag">12 mies.</span>} body="tight">
      {perf === undefined ? <Skeleton h={150} /> : (
        <>
          <Facts style={{ marginBottom: 6 }} items={[
            { label: "W tym roku", value: deposits != null ? money0(deposits, c) : "-", detail: planYtd != null ? `plan ${money0(planYtd, c)}${missed ? ` · ${plural(missed, "miesiąc", "miesiące", "miesięcy")} bez wpłaty` : ""}` : "bez planu w strategii" },
            { label: "Następna", value: dm(curDone ? nextDeposit(`${today.slice(0, 8)}31`, plan?.day ?? null) : next), detail: plan ? `${money0(plan.amount, c)} ${fromBudget ? "z nadwyżki budżetu" : "wg planu"}` : undefined },
          ]} />
          {perf && months.some((m) => m.value > 0) || plan ? (
            <Bars label="Wpłaty w ostatnich 12 miesiącach" height={120} values={months.map((m) => m.value)} labels={months.map((m) => m.label)}
              cls={months.map((m, i) => (i === months.length - 1 && !m.value && plan ? "plan" : "main"))}
              plan={plan?.amount ?? null} planLabel={plan ? `plan ${money0(plan.amount, c)}` : undefined} />
          ) : <div className="empty">Brak wpłat.</div>}
        </>
      )}
    </Widget>
  );
}

