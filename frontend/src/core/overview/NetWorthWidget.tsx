// Przegląd v2: net worth over time in the widget frame (Linia / Warstwy, scope, range); footer facts: the
// 12-month change of the total and of the liquid part ("bez nieruchomości").
import { useMemo, useState } from "react";
import { LineChart, StackedChart } from "../../charts";
import { labelIndices } from "../../chart";
import { cur, cur0, GROUP, monthYearShort, nwColorVar, pctSigned, round0 } from "../../format";
import { useAsync } from "../../hooks";
import { Seg } from "../../ui";
import { FootFacts, Widget } from "../../widgets";
import { getSeries, type SeriesResp } from "../api";
import { useSlug } from "../context";

const RANGES: [string, number | null][] = [["1M", 31], ["3M", 92], ["6M", 183], ["1R", 366], ["Max", null]];
const STACK_RANK: Record<string, number> = { property: 0, vehicle: 1, money: 2, mortgage: 3, loan: 4 };
const DAY = 86400000;

/** Change over the last 12 months of a series (first point on/after a year ago -> last). */
function yearChange(r: SeriesResp | null): { abs: number; pct: number | null } | null {
  const pts = r?.points ?? [];
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const from = new Date(new Date(last.date).getTime() - 365 * DAY).toISOString().slice(0, 10);
  const first = pts.find((p) => p.date >= from) ?? pts[0];
  if (first === last) return null;
  return { abs: last.value - first.value, pct: first.value ? (last.value - first.value) / Math.abs(first.value) : null };
}

export function NetWorthWidget() {
  const slug = useSlug();
  const [mode, setMode] = useState<"line" | "stacked">("line");
  const [scope, setScope] = useState("total");
  const [gran, setGran] = useState("monthly");
  const [range, setRange] = useState<number | null>(null);
  const q = useAsync(() => getSeries(slug, gran, scope), [slug, gran, scope]);
  const total = useAsync(() => getSeries(slug, "monthly", "total"), [slug]);
  const liquid = useAsync(() => getSeries(slug, "monthly", "liquid"), [slug]);
  const resp = q.data;
  const currency = resp?.currency ?? "PLN";
  const points = useMemo(() => {
    const all = resp?.points ?? [];
    if (range == null || !all.length) return all;
    const from = new Date(new Date(all[all.length - 1].date).getTime() - range * DAY).toISOString().slice(0, 10);
    const cut = all.filter((p) => p.date >= from);
    return cut.length >= 2 ? cut : all.slice(-2);
  }, [resp, range]);
  const comps = [...(resp?.components ?? [])].sort((a, b) => (STACK_RANK[a.key] ?? 9) - (STACK_RANK[b.key] ?? 9));
  const xl = labelIndices(points.length, 4).map((i) => ({ i, text: monthYearShort(points[i].date) }));
  const y = total.data ? yearChange(total.data) : null;
  const yl = liquid.data ? yearChange(liquid.data) : null;
  const fmtAxis = (v: number) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0, ...GROUP }).format(Math.round(v / 1000) * 1000);
  const tip = (i: number) => (
    <>
      <div className="k">{new Date(`${points[i].date}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" })}</div>
      {mode === "stacked" && comps.map((c) => points[i].components[c.key] ? <div key={c.key}>{c.label} <b>{cur(points[i].components[c.key], currency)}</b></div> : null)}
      <div>wartość netto <b>{cur(points[i].value, currency)}</b></div>
    </>
  );
  const empty = resp && !resp.points.length;
  return (
    <Widget title="Wartość netto w czasie"
      controls={
        <>
          <Seg quiet label="Rodzaj wykresu" items={[["Linia", "line"], ["Warstwy", "stacked"]]} value={mode} onChange={setMode} />
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Zakres majątku">
            <option value="total">Całość (z nieruchomością)</option>
            <option value="liquid">Płynne (tylko konta)</option>
          </select>
          <Seg quiet label="Zakres czasu" items={RANGES} value={range} onChange={setRange} />
        </>
      }
      body="tight"
      footer={
        <>
          <FootFacts items={[
            y && <>12 mies. <b className={y.abs >= 0 ? "pos" : "neg"}>{round0(y.abs) > 0 ? "+" : ""}{cur0(round0(y.abs), currency)}{y.pct != null ? ` (${pctSigned(y.pct)})` : ""}</b></>,
            yl && yl.pct != null && <>bez nieruchomości <b className={yl.pct >= 0 ? "pos" : "neg"}>{pctSigned(yl.pct)}</b></>,
          ]} />
          <span className="spacer" />
          <Seg quiet label="Krok wykresu" items={[["miesięcznie", "monthly"], ["tygodniowo", "weekly"], ["dziennie", "daily"]]} value={gran} onChange={setGran} />
        </>
      }>
      {empty ? <div className="empty">Brak danych: dodaj konta lub pozycje.</div>
        : !resp ? <div className="skeleton" style={{ height: 230 }} />
        : mode === "line" ? (
          <LineChart label={`Wartość netto w czasie, ${currency}`} height={230} padL={60} padR={110} yFmt={fmtAxis} xLabels={xl}
            series={[{ values: points.map((p) => p.value), cls: "main", area: true, endLabel: points.length ? cur0(Math.round(points[points.length - 1].value), currency) : undefined }]}
            tooltip={tip} />
        ) : (
          <StackedChart label={`Składniki wartości netto, ${currency}`} rows={points.map((p) => p.components)} keys={comps.map((c) => c.key)}
            colors={Object.fromEntries(comps.map((c) => [c.key, `var(${nwColorVar[c.key] ?? "--nw"})`]))} totals={points.map((p) => p.value)}
            xLabels={xl} yFmt={fmtAxis} tooltip={tip} />
        )}
      {mode === "stacked" && resp && !empty && (
        <div className="legend" style={{ marginTop: 6 }}>
          {comps.map((c) => <span key={c.key}><i className="sw" style={{ background: `var(${nwColorVar[c.key] ?? "--nw"})` }} />{c.label}</span>)}
        </div>
      )}
    </Widget>
  );
}
