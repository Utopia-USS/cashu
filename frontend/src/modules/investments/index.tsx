import type { ModuleDef } from "../../core/types";
import { Empty, Kpi } from "../../ui";

// Frontend half of the investments module for the F1 shell: blank page (SetupPage,
// driven by the backend's setup_status), the overview KPI placeholder and a page
// stub. The workspace itself (positions, allocation, signals, review) is F3.
export const investments: ModuleDef = {
  id: "investments",
  name: "Inwestycje",
  desc: "Rachunki maklerskie, alokacja vs strategia, sygnały z reguł i dziennik decyzji. Cotygodniowy przegląd w niedzielę.",
  hint: "Z Budżetem: wartość portfela liczy się do wartości netto. Konfiguracja przez skill w Claude Code.",
  short: "Rachunki maklerskie, alokacja vs strategia, sygnały i dziennik decyzji",
  intro: "Moduł zbiera transakcje z rachunków maklerskich, wycenia pozycje po kursach i porównuje alokację ze strategią zapisaną w pliku. Co tydzień pokazuje, co się zmieniło i które reguły zadziałały, a decyzje trafiają do dziennika.",
  skillBlurb: "Skill {skill} przeprowadzi wywiad o celach i horyzoncie, zaproponuje koszyki i reguły i zapisze strategię przez aplikację. Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.",
  skillHint: "Wywiad trwa ok. 20 minut. Strategia pojawi się w krokach powyżej jako wersja 1 do zatwierdzenia.",
  setupUntilReady: true, // no data view before F3: the tab stays the blank page until setup is complete
  tabs: [{
    id: "portfolio",
    label: "Inwestycje",
    render: () => (
      <section className="card chart-card">
        <h2>Inwestycje</h2>
        <Empty title="Widok portfela jest w przygotowaniu." hint="Pozycje, alokacja względem strategii i sygnały pojawią się tutaj. Konfiguracja modułu działa już teraz." />
      </section>
    ),
  }],
  Kpis: ({ ctx }) => {
    if (ctx.state === "ready") return null;
    return (
      <Kpi
        label="Portfel inwestycji"
        value={<span className="muted">-</span>}
        hint={<>moduł nieskonfigurowany · <button className="lnk" style={{ fontSize: 12 }} onClick={() => ctx.go({ kind: "setup", module: "investments" })}>skonfiguruj</button></>}
      />
    );
  },
};
