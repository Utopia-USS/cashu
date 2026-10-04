import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { cssVar, cur, PALETTE } from "../../format";
import type { SpendRow } from "./api";

interface Slice extends SpendRow { members?: SpendRow[] }

export function SpendingDonut({ rows, onDrill }: { rows: SpendRow[]; onDrill: (category: string, label: string) => void }) {
  const [showRest, setShowRest] = useState(false);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const roundPct = (a: number) => (total ? Math.round((a / total) * 100) : 0);

  // Collapse categories showing ≤1% into an expandable "Reszta" slice.
  const small = rows.filter((r) => roundPct(r.amount) <= 1);
  const big = rows.filter((r) => roundPct(r.amount) > 1);
  const display: Slice[] = small.length >= 2
    ? [...big, { category: "__rest__", label: "Reszta", amount: small.reduce((s, r) => s + r.amount, 0), members: small }]
    : rows;
  const color = (r: Slice, i: number) => (r.category === "__rest__" ? cssVar("--muted") : PALETTE[i % PALETTE.length]);

  const Row = ({ r, c, onClick, extra }: { r: SpendRow; c: string; onClick?: () => void; extra?: string }) => (
    <div className={`legend-row clickable ${extra || ""}`} onClick={onClick}>
      <span className="swatch" style={{ background: c }} />
      <span>{r.label}</span>
      <span className="num">{cur(r.amount)}</span>
      <span className="num muted">{roundPct(r.amount)}%</span>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={display} dataKey="amount" nameKey="label" cx="50%" cy="50%"
              innerRadius="58%" outerRadius="90%" stroke="none" isAnimationActive={false}
              onClick={(_d, i) => { const r = display[i]; if (r && r.category !== "__rest__") onDrill(r.category, r.label); }}
            >
              {display.map((r, i) => <Cell key={r.category} fill={color(r, i)} cursor="pointer" />)}
            </Pie>
            <Tooltip
              contentStyle={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 13 }}
              formatter={(v, name) => [`${cur(v as number)} (${roundPct(v as number)}%)`, name as string] as [string, string]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div>
        {display.map((r, i) => {
          if (r.category === "__rest__") {
            return (
              <div key="rest">
                <Row r={r} c={color(r, i)} onClick={() => setShowRest((s) => !s)} />
                {showRest && r.members!.map((m) => (
                  <Row key={m.category} r={m} c={cssVar("--muted")} onClick={() => onDrill(m.category, m.label)} />
                ))}
              </div>
            );
          }
          return <Row key={r.category} r={r} c={color(r, i)} onClick={() => onDrill(r.category, r.label)} />;
        })}
        <div className="bd-sum"><div><span>Suma wydatków</span><b>{cur(total)}</b></div></div>
      </div>
    </div>
  );
}
