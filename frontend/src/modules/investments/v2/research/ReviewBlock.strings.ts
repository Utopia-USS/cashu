// Texts of the review research block (src/modules/investments/v2/research/ReviewBlock.tsx). See src/i18n.ts.
import { catalog, enCount, enForm, plCount, plForm } from "../../../../i18n.ts";

type Rel = "invalidates" | "weakens" | "fulfills" | "supports";
const PL_REL: Record<Rel, [string, string, string]> = {
  invalidates: ["notatka podważa", "notatki podważają", "notatek podważa"],
  weakens: ["notatka osłabia", "notatki osłabiają", "notatek osłabia"],
  fulfills: ["notatka spełnia", "notatki spełniają", "notatek spełnia"],
  supports: ["notatka wzmacnia", "notatki wzmacniają", "notatek wzmacnia"],
};
const EN_REL: Record<Rel, [string, string]> = {
  invalidates: ["note invalidates", "notes invalidate"],
  weakens: ["note weakens", "notes weaken"],
  fulfills: ["note fulfills", "notes fulfill"],
  supports: ["note supports", "notes support"],
};

export const S = catalog({
  title: { pl: "Co mówi research", en: "What research says" },
  noneThisWeek: {
    pl: (last: string | null) => `brak w tym tygodniu${last ? ` · ostatni ${last}` : ""}`,
    en: (last: string | null) => `none this week${last ? ` · last ${last}` : ""}`,
  },
  notesFrom: { pl: (d: string, n: number | null) => `notatki z ${d}${n != null ? ` (${n})` : ""}`, en: (d: string, n: number | null) => `notes from ${d}${n != null ? ` (${n})` : ""}` },
  routine: { pl: "rutyna:", en: "routine:" },
  saturday: { pl: "sobota 07:00", en: "Saturday 07:00" },
  settings: { pl: "Ustawienia › Agent AI", en: "Settings › AI agent" },
  since: { pl: (d: string) => `od ${d}`, en: (d: string) => `since ${d}` },
  all: { pl: "wszystkie", en: "all" },
  notes: { pl: (_n: number) => "notatek", en: (n: number) => enForm(n, "note", "notes") },
  sources: { pl: (_n: number) => "źródeł", en: (n: number) => enForm(n, "source", "sources") },
  community: { pl: "ze społeczności (szum)", en: "from the community (noise)" },
  signalsFromResearch: {
    pl: (n: number) => `${plForm(n, "sygnał", "sygnały", "sygnałów")} z researchu`,
    en: (n: number) => `${enForm(n, "signal", "signals")} from research`,
  },
  theses: { pl: "Tezy", en: "Theses" },
  nChanges: { pl: (n: number) => plCount(n, "zmiana", "zmiany", "zmian"), en: (n: number) => enCount(n, "change", "changes") },
  noChanges: { pl: "bez zmian", en: "no changes" },
  was: { pl: (h: string) => `była ${h}`, en: (h: string) => `was ${h}` },
  newAssessment: { pl: "nowa ocena", en: "new assessment" },
  otherPositions: {
    pl: (n: number) => `Pozostałe ${plCount(n, "pozycja", "pozycje", "pozycji")}`,
    en: (n: number) => `Other ${enCount(n, "position", "positions")}`,
  },
  noThesisFor: { pl: (syms: string) => `${syms} bez tezy`, en: (syms: string) => `${syms} without a thesis` },
  and: { pl: " i ", en: " and " },
  nNoNotes: { pl: (n: number) => `${n} bez notatek`, en: (n: number) => `${n} without notes` },
  show: { pl: "pokaż", en: "show" },
  nNewNotes: {
    pl: (n: number) => plCount(n, "nowa notatka", "nowe notatki", "nowych notatek"),
    en: (n: number) => enCount(n, "new note", "new notes"),
  },
  noNewNotes: { pl: "bez nowych notatek", en: "no new notes" },
  noTopicData: { pl: "Brak danych tematów w tym okresie.", en: "No topic data for this period." },
  candidates: { pl: "Kandydaci", en: "Candidates" },
  nNew: { pl: (n: number) => plCount(n, "nowy", "nowe", "nowych"), en: (n: number) => `${n} new` },
  noneNew: { pl: "brak nowych", en: "none new" },
  nDismissed: { pl: (n: number) => plCount(n, "odrzucony", "odrzucone", "odrzuconych"), en: (n: number) => `${n} dismissed` },
  noNewCandidates: { pl: "Brak nowych kandydatów", en: "No new candidates" },
  nWeakened: {
    pl: (n: number) => plCount(n, "teza osłabiona", "tezy osłabione", "tez osłabionych"),
    en: (n: number) => `${enCount(n, "thesis", "theses")} weakened`,
  },
  nFulfilled: { pl: (n: number) => plCount(n, "spełniona", "spełnione", "spełnionych"), en: (n: number) => `${n} fulfilled` },
  nStrengthened: { pl: (n: number) => plCount(n, "wzmocniona", "wzmocnione", "wzmocnionych"), en: (n: number) => `${n} strengthened` },
  nCandidates: { pl: (n: number) => plCount(n, "kandydat", "kandydatów", "kandydatów"), en: (n: number) => enCount(n, "candidate", "candidates") },
  below: { pl: "niżej", en: "below" },
  relThesis: {
    pl: (rel: Rel, n: number) => `${n} ${plForm(n, ...PL_REL[rel])} tezę`,
    en: (rel: Rel, n: number) => `${n} ${enForm(n, ...EN_REL[rel])} the thesis`,
  },
  fromSaturday: { pl: "z soboty", en: "from Saturday" },
  fromDate: { pl: (d: string) => `z ${d}`, en: (d: string) => `from ${d}` },
  effect: {
    pl: (weekday: string, rel: string | null, title: string | null) => `research ${weekday}: ${rel ?? "bez zmian"}${title ? ` (${title})` : ""}`,
    en: (weekday: string, rel: string | null, title: string | null) => `research ${weekday}: ${rel ?? "no changes"}${title ? ` (${title})` : ""}`,
  },
});
