import { useSlug } from "../../core/context";
import type { Fact, ModuleCtx, ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { FactList, Skeleton } from "../../ui";
import { FootFacts, Widget } from "../../widgets";
import { normTitle, useMonthNorm } from "../../core/overview/CoreWidgets";
import { todayLocal } from "../../time";
import { getLoans, loanName } from "./api";
import { incomeShare, rateText } from "./logic";
import { Loans } from "./Loans";
import { LoansStart } from "./Start";
import { S } from "./index.strings.ts";

/** Przegląd v2: loans as compact rows (instalment, rate, end; balance and principal per month). */
function LoansWidget({ ctx }: { ctx: ModuleCtx }) {
  const { data } = useAsync(() => getLoans(ctx.slug), [ctx.slug], { key: ck(ctx.slug, "loans") });
  const perCur = new Map<string, number>();
  for (const l of data ?? []) if (l.monthly_payment) perCur.set(l.currency || "PLN", (perCur.get(l.currency || "PLN") ?? 0) + l.monthly_payment);
  const base = ctx.profile.base_currency;
  // Income of complete months, never the running one (F7 FE10).
  const norm = useMonthNorm(ctx.slug, base);
  const share = incomeShare(perCur.get(base), norm?.income);
  const today = todayLocal();
  return (
    <Widget title={S.title} count={data?.length || undefined}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "loans.list" })}>{S.title}</button>}
      body="flush tight"
      footer={perCur.size ? <FootFacts items={[<>{S.installments} <b>{[...perCur].map(([c, v]) => cur(v, c)).join(" · ")}</b>{S.perMonth}{share != null && norm ? <span title={normTitle(norm)}>{S.incomeShare(Math.round(share * 100))}</span> : ""}</>]} /> : undefined}>
      {!data ? <div style={{ padding: "0 16px" }}><Skeleton h={40} /></div> : !data.length ? <div className="empty">{S.none}</div> : (
        <table>
          <tbody>
            {data.map((l, i) => {
              const c = l.currency || "PLN";
              const next = l.schedule?.find((r) => r.date >= today);
              const meta = [l.monthly_payment ? S.installment(cur(l.monthly_payment, c)) : null, rateText(l.annual_rate), l.payoff_date ? S.until(l.payoff_date.slice(0, 4)) : null].filter(Boolean).join(" · ");
              return (
                <tr key={l.id ?? i}>
                  <td><span className="nm">{loanName(l, i)}</span><span className="sym">{meta}</span></td>
                  <td className="num neg">{cur(l.outstanding != null ? -l.outstanding : null, c)}{next && <span className="sym">-{cur(next.principal, c)}{S.perMonth}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Widget>
  );
}

function LoanFacts() {
  const slug = useSlug();
  const { data } = useAsync(() => getLoans(slug), [slug], { key: ck(slug, "loans") });
  if (!data) return <FactList facts={null} />;
  const facts: Fact[] = data.slice(0, 2).map((l, i) => [loanName(l, i), cur(l.outstanding != null ? -l.outstanding : null, l.currency || "PLN"), "neg"]);
  if (data.length > 2) facts.push([S.others, S.more(data.length - 2)]);
  // Monthly instalments per currency: never summed across currencies.
  const perCur = new Map<string, number>();
  for (const l of data) if (l.monthly_payment) perCur.set(l.currency || "PLN", (perCur.get(l.currency || "PLN") ?? 0) + l.monthly_payment);
  if (perCur.size) facts.push([S.monthlyInstallments, [...perCur].map(([c, v]) => cur(v, c)).join(" · ")]);
  return <FactList facts={facts} />;
}

export const loans: ModuleDef = {
  id: "loans",
  get name() { return S.title; },
  get desc() { return S.desc; },
  get hint() { return S.hint; },
  get short() { return S.short; },
  tabs: [{ id: "list", get label() { return S.title; }, render: () => <Loans /> }],
  Start: LoansStart,
  Facts: LoanFacts,
  overview: [{ id: "list", span: 1, order: 50, stack: "side", Widget: LoansWidget }],
};
