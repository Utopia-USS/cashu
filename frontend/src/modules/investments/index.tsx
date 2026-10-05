import { useSlug } from "../../core/context";
import type { Fact, ModuleDef } from "../../core/types";
import { useAsync } from "../../hooks";
import { FactList, Kpi } from "../../ui";
import { getOverview } from "./api";
import { dm, money, pct } from "./labels";
import { InvestmentsV2 } from "./v2/Home";
import { InvestmentsHeaderTag, InvestmentsHeroFact, InvestmentsSummaryWidget, MinimalOverview, SurplusWidget } from "./v2/Overview";

// Frontend half of the investments module: the v2 home (widget grid on thirds, one tab, wide page) with
// its sub-pages (alerts manager, asset page). The home renders its own first steps for an empty
// portfolio, so the shell's SetupPage is only reached through Przegląd / the setup view.

function InvestmentsKpis({ state, go }: { state: string; go: () => void }) {
  const slug = useSlug();
  const q = useAsync(() => (state === "empty" ? Promise.resolve(null) : getOverview(slug, null).catch(() => null)), [slug, state]);
  const k = q.data?.kpis;
  if (!k || !k.value.total) {
    return (
      <Kpi label="Portfel inwestycji" value={<span className="muted">-</span>}
        hint={<>{state === "ready" ? "brak pozycji" : "moduł nieskonfigurowany"} · <button className="lnk" style={{ fontSize: 12 }} onClick={go}>{state === "ready" ? "otwórz" : "skonfiguruj"}</button></>} />
    );
  }
  const base = q.data!.base_currency;
  return (
    <Kpi label={`Portfel inwestycji (${base})`} value={money(k.value.total, base)}
      hint={k.unrealized.pct != null ? `${pct(k.unrealized.pct, true)} od kosztu` : undefined}
      hintCls={k.unrealized.pct == null ? undefined : k.unrealized.pct >= 0 ? "pos" : "neg"} />
  );
}

function InvestmentsFacts() {
  const slug = useSlug();
  const q = useAsync(() => getOverview(slug, null), [slug]);
  if (!q.data) return <FactList facts={q.error ? [] : null} />;
  const k = q.data.kpis;
  const c = q.data.base_currency;
  const facts: Fact[] = [
    ["Wartość portfela", money(k.value.total, c)],
    ["Sygnały", k.signals.action ? `${k.signals.action} do działania · ${k.signals.info} do przeglądu` : `${k.signals.info} do przeglądu`, k.signals.action ? "neg" : undefined],
  ];
  if (k.last_run) facts.push(["Reguły", `${dm(k.last_run.finished_at ?? k.last_run.started_at)} · ${k.last_run.status === "ok" ? "ok" : k.last_run.status === "partial" ? "częściowy" : "błąd"}`]);
  return <FactList facts={facts} />;
}

export const investments: ModuleDef = {
  id: "investments",
  name: "Inwestycje",
  desc: "Rachunki maklerskie, alokacja vs strategia, sygnały z reguł i dziennik decyzji. Cotygodniowy przegląd w niedzielę.",
  hint: "Z Budżetem: wartość portfela liczy się do wartości netto. Konfiguracja przez skill w Claude Code.",
  short: "Rachunki maklerskie, alokacja vs strategia, sygnały i dziennik decyzji",
  intro: "Moduł zbiera transakcje z rachunków maklerskich, wycenia pozycje po kursach i porównuje alokację ze strategią zapisaną w pliku. Co tydzień pokazuje, co się zmieniło i które reguły zadziałały, a decyzje trafiają do dziennika.",
  skillBlurb: "Skill {skill} przeprowadzi wywiad o celach i horyzoncie, zaproponuje koszyki i reguły i prześle strategię jako propozycję, którą zatwierdzasz w aplikacji (Ustawienia → Agent AI). Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.",
  skillHint: "Wywiad trwa ok. 1,5-2 h i można go rozłożyć na kilka posiedzeń. Strategia pojawi się w krokach powyżej jako propozycja do zatwierdzenia.",
  ownSetup: true,
  tabs: [{ id: "portfolio", label: "Inwestycje", wide: true, render: (ctx) => <InvestmentsV2 ctx={ctx} /> }],
  Kpis: ({ ctx }) => <InvestmentsKpis state={ctx.state} go={() => ctx.go({ kind: "tab", tab: "investments.portfolio" })} />,
  Facts: InvestmentsFacts,
  overview: [
    { id: "surplus", span: 1, order: 20, needs: ["budget"], Widget: SurplusWidget },
    { id: "summary", span: 1, order: 30, Widget: InvestmentsSummaryWidget },
  ],
  HeroFact: InvestmentsHeroFact,
  MinimalOverview,
  HeaderTag: InvestmentsHeaderTag,
};
