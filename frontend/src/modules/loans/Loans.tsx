import { useState } from "react";
import { Line, Tooltip } from "recharts";
import { ScrollableChart } from "../../components/ScrollableChart";
import { useShell, useSlug } from "../../core/context";
import { cssVar, cur, cur0, dtFmt } from "../../format";
import { intlLocale } from "../../i18n.ts";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { Empty, Kpi, SkeletonChart, SkeletonKpis, SkeletonTable } from "../../ui";
import { getLoans, type LoanInfo, loanName } from "./api";
import { S } from "./Loans.strings.ts";

const DAY = 86400000;
const xTickFmt = new Intl.DateTimeFormat(intlLocale(), { month: "short", year: "2-digit" });
const ranges = (): [string, number | null][] => [[S.oneYear, 365], [S.years(5), 1825], [S.years(10), 3650], [S.max, null]];

/** Kredyty: every loan of the profile in one table, details of the selected one below. */
export function Loans() {
  const slug = useSlug();
  const { data, error } = useAsync(() => getLoans(slug), [slug], { key: ck(slug, "loans") });
  const [sel, setSel] = useState(0);
  const { go } = useShell();

  // A failed refresh keeps the last list on screen (F7 PX2); the error alone only without data.
  if (error && !data) return <div className="err">{S.error(error)}</div>;
  if (!data) return <><SkeletonTable rows={2} /><SkeletonKpis n={5} /><SkeletonChart /></>;
  if (!data.length) {
    return (
      <section className="card chart-card">
        <h2>{S.title}</h2>
        <Empty title={S.none} action={<button className="btn" onClick={() => go({ kind: "setup", module: "loans" })}>{S.setup}</button>} />
      </section>
    );
  }

  const i = Math.min(sel, data.length - 1);
  return (
    <>
      <section className="card chart-card">
        <div className="controls">
          <h2 style={{ margin: 0 }}>{S.title}</h2>
          <span className="tag">{S.nLoans(data.length)}</span>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>{S.loan}</th><th className="num">{S.installment}</th><th className="num">{S.remaining}</th><th className="num">{S.totalInterest}</th><th>{S.payoffBy}</th></tr>
            </thead>
            <tbody>
              {data.map((l, k) => {
                const c = l.currency || "PLN";
                return (
                  <tr key={l.id ?? k} className="clickable" onClick={() => setSel(k)}
                    style={k === i ? { background: "var(--chip)" } : undefined}>
                    <td>
                      <button className="lnk" style={{ fontSize: 14, color: "var(--text)", textDecoration: "none", fontWeight: k === i ? 600 : 400 }}
                        aria-pressed={k === i} onClick={(e) => { e.stopPropagation(); setSel(k); }}>
                        {loanName(l, k)}
                      </button>
                    </td>
                    <td className="num">{cur(l.monthly_payment, c)}</td>
                    <td className="num neg">{cur(l.outstanding != null ? -l.outstanding : null, c)}</td>
                    <td className="num">{cur(l.total_interest, c)}</td>
                    <td>{l.payoff_date || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <LoanDetail key={i} loan={data[i]} name={loanName(data[i], i)} />
    </>
  );
}

function LoanDetail({ loan, name }: { loan: LoanInfo; name: string }) {
  const c = loan.currency || "PLN";
  const series = (loan.series ?? []).map((p) => ({ x: new Date(p.date).getTime(), y: p.balance }));
  const spanDays = series.length >= 2 ? (series[series.length - 1].x - series[0].x) / DAY : 0;

  return (
    <>
      <div className="kpis">
        <Kpi label={S.monthlyInstallment} value={cur(loan.monthly_payment, c)} />
        <Kpi label={S.remaining} value={cur(loan.outstanding, c)} cls="neg" />
        <Kpi label={S.totalInterest} value={cur(loan.total_interest, c)} />
        <Kpi label={S.paidInterest} value={cur(loan.paid_interest, c)} />
        <Kpi label={S.payoffDate} value={loan.payoff_date || "-"} hint={loan.months_elapsed != null ? S.paidCount(loan.months_elapsed) : ""} />
      </div>

      <ScrollableChart
        title={S.balanceOf(name)}
        data={series}
        yValues={series.map((s) => s.y)}
        xAxisProps={{
          dataKey: "x", type: "number", scale: "time", domain: ["dataMin", "dataMax"],
          tickFormatter: (ms: number) => xTickFmt.format(new Date(ms)), minTickGap: 40,
        }}
        ranges={ranges()}
        fullSpan={spanDays}
        yTickFormatter={(v) => cur0(v, c)}
        emptyText={S.noSchedule}
        tooltip={
          <Tooltip
            contentStyle={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 13 }}
            labelStyle={{ color: cssVar("--muted") }}
            labelFormatter={(ms) => dtFmt.format(new Date(ms as number))}
            formatter={(v) => [cur(v as number, c), S.balance] as [string, string]}
          />
        }
      >
        <Line type="monotone" dataKey="y" stroke={cssVar("--neg")} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ScrollableChart>

      {/* section.card: same small uppercase heading as every other titled card (design decision 13) */}
      <section className="card chart-card">
        <h2>{S.schedule}</h2>
        <div className="scroll tall">
          <table>
            <thead>
              <tr><th className="num">#</th><th>{S.date}</th><th className="num">{S.installment}</th><th className="num">{S.interest}</th><th className="num">{S.principal}</th><th className="num">{S.balance}</th></tr>
            </thead>
            <tbody>
              {(loan.schedule ?? []).map((s) => (
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
      </section>
    </>
  );
}
