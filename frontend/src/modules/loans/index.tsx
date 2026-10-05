import { useSlug } from "../../core/context";
import type { Fact, ModuleCtx, ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { FactList, Skeleton } from "../../ui";
import { FootFacts, Widget } from "../../widgets";
import { getLoans, loanName } from "./api";
import { Loans } from "./Loans";

/** Przegląd v2: loans as compact rows (instalment, rate, end; balance and principal per month). */
function LoansWidget({ ctx }: { ctx: ModuleCtx }) {
  const { data } = useAsync(() => getLoans(ctx.slug), [ctx.slug]);
  const perCur = new Map<string, number>();
  for (const l of data ?? []) if (l.monthly_payment) perCur.set(l.currency || "PLN", (perCur.get(l.currency || "PLN") ?? 0) + l.monthly_payment);
  const base = ctx.profile.base_currency;
  const income = ctx.summary.month?.income ?? null;
  const share = income && perCur.get(base) ? (perCur.get(base)! / income) : null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Widget title="Kredyty" count={data?.length || undefined}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "loans.list" })}>Kredyty</button>}
      body="flush tight"
      footer={perCur.size ? <FootFacts items={[<>raty <b>{[...perCur].map(([c, v]) => cur(v, c)).join(" · ")}</b> / mies.{share != null ? ` · ${Math.round(share * 100)} % przychodów` : ""}</>]} /> : undefined}>
      {!data ? <div style={{ padding: "0 16px" }}><Skeleton h={40} /></div> : !data.length ? <div className="empty">Brak kredytów.</div> : (
        <table>
          <tbody>
            {data.map((l, i) => {
              const c = l.currency || "PLN";
              const next = l.schedule?.find((r) => r.date >= today);
              const meta = [l.monthly_payment ? `rata ${cur(l.monthly_payment, c)}` : null, l.annual_rate != null ? `${(l.annual_rate * (l.annual_rate < 1 ? 100 : 1)).toLocaleString("pl-PL", { maximumFractionDigits: 2 })} %` : null, l.payoff_date ? `do ${l.payoff_date.slice(0, 4)}` : null].filter(Boolean).join(" · ");
              return (
                <tr key={l.id ?? i}>
                  <td><span className="nm">{loanName(l, i)}</span><span className="sym">{meta}</span></td>
                  <td className="num neg">{cur(l.outstanding != null ? -l.outstanding : null, c)}{next && <span className="sym">-{cur(next.principal, c)} / mies.</span>}</td>
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
  const { data } = useAsync(() => getLoans(slug), [slug]);
  if (!data) return <FactList facts={null} />;
  const facts: Fact[] = data.slice(0, 2).map((l, i) => [loanName(l, i), cur(l.outstanding != null ? -l.outstanding : null, l.currency || "PLN"), "neg"]);
  if (data.length > 2) facts.push(["Pozostałe", `${data.length - 2} kolejne`]);
  // Monthly instalments per currency: never summed across currencies.
  const perCur = new Map<string, number>();
  for (const l of data) if (l.monthly_payment) perCur.set(l.currency || "PLN", (perCur.get(l.currency || "PLN") ?? 0) + l.monthly_payment);
  if (perCur.size) facts.push(["Raty w miesiącu", [...perCur].map(([c, v]) => cur(v, c)).join(" · ")]);
  return <FactList facts={facts} />;
}

export const loans: ModuleDef = {
  id: "loans",
  name: "Kredyty",
  desc: "Hipoteka i inne kredyty: harmonogram, odsetki, saldo w czasie. Wiele kredytów na profil.",
  hint: "Z Budżetem: raty nie są liczone jako subskrypcje.",
  short: "Harmonogramy kredytów, odsetki i saldo w czasie",
  intro: "Moduł prowadzi harmonogramy kredytów i liczy saldo w czasie. Raty są rozpoznawane w Budżecie jako spłata, nie subskrypcja.",
  skillBlurb: "Skill {skill} zapyta o kwotę, oprocentowanie, ratę i datę startu każdego kredytu i przygotuje polecenia, które uruchomisz w swoim terminalu. Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.",
  skillHint: "Kroki powyżej odświeżą się same, gdy skill zapisze kredyt w aplikacji.",
  tabs: [{ id: "list", label: "Kredyty", render: () => <Loans /> }],
  Facts: LoanFacts,
  overview: [{ id: "list", span: 1, order: 50, stack: "side", Widget: LoansWidget }],
};
