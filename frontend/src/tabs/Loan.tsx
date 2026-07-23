import { Line, Tooltip } from "recharts";
import { getLoan } from "../api";
import { ScrollableChart } from "../components/ScrollableChart";
import { cssVar, cur, dtFmt } from "../format";
import { useAsync } from "../hooks";
import { Kpi, SkeletonChart, SkeletonKpis } from "../ui";

const DAY = 86400000;
const xTickFmt = new Intl.DateTimeFormat("pl-PL", { month: "short", year: "2-digit" });
const RANGES: [string, number | null][] = [["1R", 365], ["5L", 1825], ["10L", 3650], ["Max", null]];

export function Loan() {
  const { data } = useAsync(getLoan, []);
  if (!data) return <><SkeletonKpis n={5} /><SkeletonChart /></>;
  if (!data.has_loan) return <div className="card muted">Brak kredytu. Dodaj kredyt: finanse set-loan …</div>;

  const c = data.currency || "PLN";
  const series = (data.series ?? []).map((p) => ({ x: new Date(p.date).getTime(), y: p.balance }));
  const spanDays = series.length >= 2 ? (series[series.length - 1].x - series[0].x) / DAY : 0;

  return (
    <>
      <div className="kpis">
        <Kpi label="Rata miesięczna" value={cur(data.monthly_payment, c)} />
        <Kpi label="Pozostało do spłaty" value={cur(data.outstanding, c)} cls="neg" />
        <Kpi label="Odsetki łącznie" value={cur(data.total_interest, c)} />
        <Kpi label="Spłacone odsetki" value={cur(data.paid_interest, c)} />
        <Kpi label="Data spłaty" value={data.payoff_date || "—"} hint={data.months_elapsed != null ? `${data.months_elapsed} rat spłaconych` : ""} />
      </div>

      <ScrollableChart
        title="Pozostałe saldo kredytu w czasie"
        data={series}
        yValues={series.map((s) => s.y)}
        xAxisProps={{
          dataKey: "x", type: "number", scale: "time", domain: ["dataMin", "dataMax"],
          tickFormatter: (ms: number) => xTickFmt.format(new Date(ms)), minTickGap: 40,
        }}
        ranges={RANGES}
        fullSpan={spanDays}
        tooltip={
          <Tooltip
            contentStyle={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 13 }}
            labelStyle={{ color: cssVar("--muted") }}
            labelFormatter={(ms) => dtFmt.format(new Date(ms as number))}
            formatter={(v) => [cur(v as number, c), "Saldo"] as [string, string]}
          />
        }
      >
        <Line type="monotone" dataKey="y" stroke={cssVar("--neg")} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ScrollableChart>

      <div className="card chart-card">
        <h2>Harmonogram spłat</h2>
        <div className="scroll tall">
          <table>
            <thead>
              <tr><th className="num">#</th><th>Data</th><th className="num">Rata</th><th className="num">Odsetki</th><th className="num">Kapitał</th><th className="num">Saldo</th></tr>
            </thead>
            <tbody>
              {(data.schedule ?? []).map((s) => (
                <tr key={s.n}>
                  <td className="num">{s.n}</td>
                  <td>{s.date}</td>
                  <td className="num">{cur(s.payment, c)}</td>
                  <td className="num">{cur(s.interest, c)}</td>
                  <td className="num">{cur(s.principal, c)}</td>
                  <td className="num">{cur(s.balance, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
