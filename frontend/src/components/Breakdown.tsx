import type { Breakdown as BD } from "../core/api";
import { cur, TYPE_LABEL } from "../format";

export function Breakdown({ bd }: { bd: BD }) {
  const entries = Object.entries(bd.by_type)
    .filter(([, v]) => Math.abs(v) > 0.005)
    .sort((a, b) => b[1] - a[1]);
  const maxAbs = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));

  return (
    <section className="card chart-card">
      <h2>Aktywa vs zobowiązania ({bd.currency})</h2>
      {entries.map(([t, v]) => {
        const liab = v < 0;
        return (
          <div className="bd-row" key={t}>
            <div>{TYPE_LABEL[t] || t}</div>
            <div>
              <div className={`bar ${liab ? "liab" : ""}`} style={{ width: `${(Math.abs(v) / maxAbs) * 100}%` }} />
            </div>
            <div className={`num ${liab ? "neg" : ""}`}>{cur(v)}</div>
          </div>
        );
      })}
      <div className="bd-sum">
        <div><span>Aktywa</span><b className="pos">{cur(bd.assets)}</b></div>
        <div><span>Zobowiązania</span><b className={bd.liabilities ? "neg" : ""}>{cur(bd.liabilities ? -bd.liabilities : 0)}</b></div>
        <div><span>Net worth</span><b>{cur(bd.net)}</b></div>
        {(bd.property || bd.mortgage) ? (
          <div><span>Home equity (nieruchomość − hipoteka)</span><b>{cur(bd.home_equity)}</b></div>
        ) : null}
      </div>
    </section>
  );
}
