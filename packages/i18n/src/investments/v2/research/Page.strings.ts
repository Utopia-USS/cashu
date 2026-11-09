// Texts of the research view (frontend/src/modules/investments/v2/research/Page.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../../../index.js";

export const PRIVACY_SHORT = catalog({
  strict: { pl: "ścisły", en: "strict" },
  amounts: { pl: "z kwotami", en: "with amounts" },
});

export const S = catalog({
  crumb: { pl: "Ścieżka", en: "Breadcrumb" },
  investments: { pl: "Inwestycje", en: "Investments" },
  research: { pl: "Research", en: "Research" },
  runNow: { pl: "Uruchom teraz", en: "Run now" },
  scope: { pl: "Zakres", en: "Scope" },

  // run strip
  running: { pl: "trwa", en: "running" },
  interrupted: { pl: "przerwane", en: "interrupted" },
  finished: { pl: "zakończone", en: "finished" },
  candidates: { pl: "Kandydaci", en: "Candidates" },

  // candidates
  byStrategy: {
    pl: (v: number | null) => (v != null ? `wg strategii v${v}` : "wg strategii"),
    en: (v: number | null) => (v != null ? `by strategy v${v}` : "by the strategy"),
  },
  noCandidates: { pl: "Brak kandydatów.", en: "No candidates." },

  // runs
  scopePositions: { pl: "pozycje", en: "positions" },
  scopeWatched: { pl: "obserwowane", en: "watchlist" },
  scopeCandidates: { pl: "kandydaci", en: "candidates" },
  scopeTopics: { pl: "tematy", en: "topics" },
  runs: { pl: "Uruchomienia", en: "Runs" },
  lastN: { pl: (n: number) => `ostatnie ${n}`, en: (n: number) => `last ${n}` },
  routine: { pl: "rutyna:", en: "routine:" },
  saturday: { pl: "sobota 07:00", en: "Saturday 07:00" },
  colDate: { pl: "Data", en: "Date" },
  colStatus: { pl: "Status", en: "Status" },
  colScope: { pl: "Zakres", en: "Scope" },
  colNotes: { pl: "Notatki", en: "Notes" },
  colSignalsTitle: {
    pl: "Sygnał powstaje, gdy notatka podważa tezę (do działania) albo ma siłę 3 (informacja)",
    en: "A signal is created when a note invalidates the thesis (to act on) or has strength 3 (info)",
  },
  colSignals: { pl: "Sygnały", en: "Signals" },
  colTime: { pl: "Czas", en: "Time" },
  colStartedBy: { pl: "Uruchomił", en: "Started by" },
  onDemandSuffix: { pl: " (na żądanie)", en: " (on demand)" },
  you: { pl: "Ty · Claude Code", en: "You · Claude Code" },
  routineBy: {
    pl: (what: string) => `rutyna · ${what}`,
    en: (what: string) => `routine · ${what}`,
  },

  // scope and rules
  scopeRules: { pl: "Zakres i zasady", en: "Scope and rules" },
  scopeLine: {
    pl: (held: number, watched: number) =>
      `${plCount(held, "pozycja", "pozycje", "pozycji")}, ${plCount(watched, "obserwowana", "obserwowane", "obserwowanych")}`,
    en: (held: number, watched: number) =>
      `${enCount(held, "position", "positions")}, ${watched} watched`,
  },
  scopeRest: {
    pl: (v: string) => `, kandydaci wg kryteriów wejścia strategii${v}, tematy`,
    en: (v: string) => `, candidates by the strategy${v} entry criteria, topics`,
  },
  sources: { pl: "Źródła", en: "Sources" },
  sourcesList: {
    pl: "wiadomości, raporty, społeczność (szum), przepływy ETF, trendy",
    en: "news, reports, community (noise), ETF flows, trends",
  },
  not: { pl: "Nie", en: "Not" },
  notList: {
    pl: "rekomendacje, prognozy cen, omijanie paywalli",
    en: "recommendations, price forecasts, getting around paywalls",
  },
  privacy: { pl: "Prywatność", en: "Privacy" },
  privacyLine: {
    pl: (level: string, amounts: boolean) =>
      `poziom ${level} · ${amounts ? "także kwoty, bez numerów kont" : "wagi i tezy, bez kwot i rachunków"}`,
    en: (level: string, amounts: boolean) =>
      `level ${level} · ${amounts ? "amounts too, no account numbers" : "weights and theses, no amounts or accounts"}`,
  },
  workspace: { pl: "Workspace", en: "Workspace" },
  mcpOnly: { pl: " · dane tylko przez MCP", en: " · data only through MCP" },
  validity: { pl: "Ważność", en: "Validity" },
  validityLine: {
    pl: "notatka 30 dni, notatka tematu 1 na tydzień, odrzucony kandydat 90 dni",
    en: "note 30 days, topic note 1 per week, dismissed candidate 90 days",
  },

  // never ran
  createWorkspace: { pl: "Utwórz workspace profilu", en: "Create the profile workspace" },
  settings: { pl: "Ustawienia › Agent AI", en: "Settings › AI agent" },
  skill: { pl: "Skill", en: "Skill" },
  installed: { pl: "zainstalowany", en: "installed" },
  toInstall: { pl: "do zainstalowania", en: "to install" },
  inWorkspace: { pl: "w workspace profilu", en: "in the profile workspace" },
  inWorkspaceAt: { pl: "w workspace", en: "in the workspace" },
  updateWorkspace: {
    pl: "Ustawienia › Agent AI › Aktualizuj workspace (albo",
    en: "Settings › AI agent › Update workspace (or",
  },
  firstRun: {
    pl: "Uruchom pierwszy research w Claude Code",
    en: "Run the first research in Claude Code",
  },
  about30: { pl: "ok. 30 min", en: "about 30 min" },
  copy: { pl: "Kopiuj", en: "Copy" },
  scheduleSaturdays: { pl: "Zaplanuj rutynę na soboty", en: "Schedule the Saturday routine" },
  howToSchedule: { pl: "Jak zaplanować", en: "How to schedule" },
  neverRan: { pl: "jeszcze nie działał", en: "hasn't run yet" },
  lead: {
    pl: "Co sobotę: wiadomości, raporty, sentyment i trendy dla pozycji, obserwowanych i kandydatów.",
    en: "Every Saturday: news, reports, sentiment and trends for positions, the watchlist and candidates.",
  },
  noRecommendations: { pl: "Bez rekomendacji i prognoz.", en: "No recommendations or forecasts." },
});
