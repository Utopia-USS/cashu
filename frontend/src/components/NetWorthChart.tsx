import { useMemo, useState } from "react";
import { Area, Line, Tooltip } from "recharts";
import { getSeries, type SeriesComponent } from "../core/api";
import { useSlug } from "../core/context";
import { cssVar, cur, dtFmt, nwColorVar } from "../format";
import { useAsync } from "../hooks";
import { Seg } from "../ui";
import { ScrollableChart } from "./ScrollableChart";

const RANGES: [string, number | null][] = [
  ["1M", 30], ["3M", 90], ["6M", 180], ["1R", 365], ["Max", null],
];
const DAY = 86400000;
const xTickFmt = new Intl.DateTimeFormat("pl-PL", { month: "short", year: "2-digit" });

// Stacking order, from the zero axis outward: least-liquid / most-stable nearest
// 0, most-volatile (money) on the outer edge. Assets (positive) are grouped
// before liabilities (negative) — Recharts' sign-stacking mis-places areas when
// the two signs are interleaved, so we must not interleave them.
const STACK_RANK: Record<string, number> = { property: 0, vehicle: 1, money: 2, mortgage: 3, loan: 4 };

type Row = { x: number; y: number } & Record<string, number>;

/** Tooltip showing the net-worth composition at a point in time — every present
 * component (money / auto / property / − liabilities), then the total. */
function NwTooltip({ comps }: { comps: SeriesComponent[] }) {
  return function Content({ active, payload }: { active?: boolean; payload?: { payload?: Row }[] }) {
    const row = active && payload?.[0]?.payload;
    if (!row) return null;
    return (
      <div style={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 13, padding: "8px 10px" }}>
        <div style={{ color: cssVar("--muted"), marginBottom: 6 }}>{dtFmt.format(new Date(row.x))}</div>
        {comps.map((c) => {
          const v = row[c.key];
          if (v == null || v === 0) return null;
          return (
            <div key={c.key} style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <i style={{ width: 9, height: 9, borderRadius: 2, background: cssVar(nwColorVar[c.key] ?? "--nw") }} />
                {c.label}
              </span>
              <span className={c.liability ? "neg" : ""} style={{ fontVariantNumeric: "tabular-nums" }}>{cur(v)}</span>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTop: `1px solid ${cssVar("--border")}`, fontWeight: 600 }}>
          <span>Net worth</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{cur(row.y)}</span>
        </div>
      </div>
    );
  };
}

export function NetWorthChart() {
  const [scope, setScope] = useState("total");
  const [gran, setGran] = useState("monthly");
  const [mode, setMode] = useState<"line" | "stacked">("line");
  const slug = useSlug();
  const { data: resp } = useAsync(() => getSeries(slug, gran, scope), [slug, gran, scope]);

  const comps = resp?.components ?? [];
  const points = useMemo<Row[]>(
    () =>
      (resp?.points ?? []).map((p) => {
        const row = { x: new Date(p.date).getTime(), y: p.value } as Row;
        for (const c of comps) row[c.key] = p.components[c.key] ?? 0;
        return row;
      }),
    [resp],
  );
  const spanDays = points.length >= 2 ? (points[points.length - 1].x - points[0].x) / DAY : 0;

  // Stacked mode needs a domain that spans the positive stack top and the
  // negative stack bottom; line mode just tracks the total.
  const yValues = useMemo(() => {
    if (mode === "line") return points.map((p) => p.y);
    const vals: number[] = [0];
    for (const p of points) {
      let pos = 0, neg = 0;
      for (const c of comps) (p[c.key] >= 0 ? (pos += p[c.key]) : (neg += p[c.key]));
      vals.push(pos, neg, p.y);
    }
    return vals;
  }, [points, comps, mode]);

  // Stack the least-liquid classes nearest the zero axis: they change slowly, so
  // the volatile "money" band rides on the outer edge instead of shifting the rest.
  const stacked = [...comps].sort((a, b) => (STACK_RANK[a.key] ?? 9) - (STACK_RANK[b.key] ?? 9));

  const marks =
    mode === "stacked"
      ? [
          // No smoothing (type="linear") and no boundary strokes — areas are the fills,
          // the only line on the chart is the effective net worth. Assets and
          // liabilities live in SEPARATE, single-signed stacks so each stays on its
          // own side of 0 (Recharts' "sign" offset mis-places zero-valued series).
          ...stacked.map((c) => (
            <Area
              key={c.key} type="linear" dataKey={c.key} stackId={c.liability ? "liab" : "assets"}
              stroke="none" fill={cssVar(nwColorVar[c.key] ?? "--nw")} fillOpacity={0.8}
              isAnimationActive={false}
            />
          )),
          <Line key="__total" type="linear" dataKey="y" stroke={cssVar("--text")} strokeWidth={1.75} dot={false} isAnimationActive={false} />,
        ]
      : [<Line key="__line" type="monotone" dataKey="y" stroke={cssVar("--nw")} strokeWidth={2} dot={false} isAnimationActive={false} />];

  const controls = (
    <>
      <Seg items={[["Linia", "line"], ["Warstwy", "stacked"]]} value={mode} onChange={setMode} />
      <select value={scope} onChange={(e) => setScope(e.target.value)} title="Zakres majątku">
        <option value="total">Całość (z nieruchomością)</option>
        <option value="liquid">Płynne (tylko konta)</option>
      </select>
      <select value={gran} onChange={(e) => setGran(e.target.value)} title="Wygładzanie">
        <option value="monthly">miesięcznie</option>
        <option value="weekly">tygodniowo</option>
        <option value="daily">dziennie</option>
      </select>
    </>
  );

  return (
    <ScrollableChart
      title="Net worth w czasie"
      controls={controls}
      data={points}
      yValues={yValues}
      xAxisProps={{
        dataKey: "x", type: "number", scale: "time", domain: ["dataMin", "dataMax"],
        tickFormatter: (ms: number) => xTickFmt.format(new Date(ms)), minTickGap: 40,
      }}
      ranges={RANGES}
      fullSpan={spanDays}
      yZoomable
      emptyText={resp && !resp.points.length ? "Brak danych do wykresu. Pojawią się po dodaniu kont lub pozycji." : undefined}
      tooltip={<Tooltip cursor={{ stroke: cssVar("--muted"), strokeDasharray: "3 3" }} content={NwTooltip({ comps })} />}
    >
      {marks}
    </ScrollableChart>
  );
}
