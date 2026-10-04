import { useSlug } from "../../core/context";
import type { Fact, ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { FactList } from "../../ui";
import { getLoans, loanName } from "./api";
import { Loans } from "./Loans";

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
  skillBlurb: "Skill {skill} zapyta o kwotę, oprocentowanie, ratę i datę startu każdego kredytu i zapisze je przez aplikację. Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.",
  skillHint: "Kroki powyżej odświeżą się same, gdy skill zapisze kredyt w aplikacji.",
  tabs: [{ id: "list", label: "Kredyty", render: () => <Loans /> }],
  Facts: LoanFacts,
};
