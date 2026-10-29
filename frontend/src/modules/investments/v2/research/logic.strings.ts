// Texts of the research layer logic (src/modules/investments/v2/research/logic.ts): the copy deck maps and
// the texts its helpers return. See src/i18n.ts.
import { catalog, enCount, enForm, plCount, plForm } from "../../../../i18n.ts";

export const KIND_LABEL = catalog({
  news: { pl: "wiadomość", en: "news" },
  earnings: { pl: "wyniki", en: "earnings" },
  community: { pl: "społeczność · szum", en: "community · noise" },
  trend: { pl: "trend", en: "trend" },
  macro: { pl: "makro", en: "macro" },
  candidate: { pl: "kandydat", en: "candidate" },
});

export const POLARITY_WORD = catalog({
  positive: { pl: "pozytywna", en: "positive" },
  negative: { pl: "negatywna", en: "negative" },
  neutral: { pl: "neutralna", en: "neutral" },
});

export const RELATION_LABEL = catalog({
  supports: { pl: "wzmacnia tezę", en: "supports the thesis" },
  weakens: { pl: "osłabia tezę", en: "weakens the thesis" },
  invalidates: { pl: "podważa tezę", en: "invalidates the thesis" },
  fulfills: { pl: "spełnia tezę", en: "fulfills the thesis" },
  neutral: { pl: "nie dotyka tezy", en: "doesn't touch the thesis" },
  none: { pl: "bez tezy", en: "no thesis" },
});

export const HEALTH_LABEL = catalog({
  inv: { pl: "podważona", en: "invalidated" },
  weak: { pl: "osłabiona", en: "weakened" },
  ful: { pl: "spełniona", en: "fulfilled" },
  sup: { pl: "wzmocniona", en: "strengthened" },
  ok: { pl: "aktualna", en: "current" },
  no_thesis: { pl: "bez tezy", en: "no thesis" },
  no_research: { pl: "bez researchu", en: "no research" },
});

export const DIRECTION_LABEL = catalog({
  up: { pl: "rośnie", en: "rising" },
  down: { pl: "słabnie", en: "weakening" },
  flat: { pl: "stabilnie", en: "stable" },
});

export const THESIS_FIELD_LABEL = catalog({
  entry_type: { pl: "Typ wejścia", en: "Entry type" },
  thesis: { pl: "Wejście", en: "Entry" },
  invalidation: { pl: "Unieważnienie", en: "Invalidation" },
  exit_plan: { pl: "Plan wyjścia", en: "Exit plan" },
  size_plan: { pl: "Wielkość i dokupienia", en: "Size and adding to it" },
});

/** Community noise scale (`details.scale`). */
export const NOISE_SCALE = catalog({
  small: { pl: "szum: skala mała", en: "noise: small scale" },
  medium: { pl: "szum: skala średnia", en: "noise: medium scale" },
  large: { pl: "szum: skala duża", en: "noise: large scale" },
});

type Rel = "invalidates" | "weakens" | "fulfills" | "supports";
/** Relation verbs: [one, few] (Polish) / [one, other] (English). */
const PL_VERB: Record<Rel, [string, string]> = {
  invalidates: ["podważa", "podważają"], weakens: ["osłabia", "osłabiają"], fulfills: ["spełnia", "spełniają"], supports: ["wzmacnia", "wzmacniają"],
};
const EN_VERB: Record<Rel, [string, string]> = {
  invalidates: ["invalidates", "invalidate"], weakens: ["weakens", "weaken"], fulfills: ["fulfills", "fulfill"], supports: ["supports", "support"],
};

export const S = catalog({
  /** Kind filter of the research view: [label, kind] (plural forms). */
  kindFilter: {
    pl: [["wiadomości", "news"], ["wyniki", "earnings"], ["społeczność", "community"], ["trendy", "trend"], ["makro", "macro"]] as [string, string][],
    en: [["news", "news"], ["earnings", "earnings"], ["community", "community"], ["trends", "trend"], ["macro", "macro"]],
  },
  strengthWord: { pl: ["", "słaba", "umiarkowana", "silna"] as readonly string[], en: ["", "weak", "moderate", "strong"] },
  strengthTitle: {
    pl: (v: number, word: string) => `siła ${v} z 3 (${word})`,
    en: (v: number, word: string) => `strength ${v} of 3 (${word})`,
  },
  boundary: { pl: "bez rekomendacji i prognoz", en: "no recommendations or forecasts" },
  /** Where the owner sets the routine up in the Claude desktop app. */
  routineMenu: { pl: "Claude (aplikacja) › Code › Routines › Nowa rutyna › Lokalna", en: "Claude (app) › Code › Routines › New routine › Local" },
  scheduleSteps: {
    pl: (menu: string, path: string, prompt: string) => `${menu}: sobota 07:00, folder ${path}, polecenie ${prompt}`,
    en: (menu: string, path: string, prompt: string) => `${menu}: Saturday 07:00, folder ${path}, prompt ${prompt}`,
  },
  today: { pl: "dziś", en: "today" },
  yesterday: { pl: "wczoraj", en: "yesterday" },
  signalOpen: { pl: "sygnał otwarty", en: "signal open" },
  signalClosed: { pl: "sygnał zamknięty", en: "signal closed" },
  expiry: {
    pl: (expired: boolean, d: string) => `${expired ? "wygasła" : "wygasa"} ${d}`,
    en: (expired: boolean, d: string) => `${expired ? "expired" : "expires"} ${d}`,
  },
  source: { pl: "źródło", en: "source" },

  // counts line and field chips
  nNotes: { pl: (n: number) => plCount(n, "notatka", "notatki", "notatek"), en: (n: number) => enCount(n, "note", "notes") },
  lately: { pl: (p: string) => `ostatnio ${p}`, en: (p: string) => `lately ${p}` },
  noNotes30: { pl: "brak notatek z 30 dni", en: "no notes in 30 days" },
  relCount: {
    pl: (rel: Rel, n: number) => plCount(n, PL_VERB[rel][0], PL_VERB[rel][1], PL_VERB[rel][0]),
    en: (rel: Rel, n: number) => `${n} ${enForm(n, EN_VERB[rel][0], EN_VERB[rel][1])}`,
  },
  noise: { pl: (n: number) => `${n} szum`, en: (n: number) => `${n} noise` },
  nNeutral: { pl: (n: number) => plCount(n, "neutralna", "neutralne", "neutralnych"), en: (n: number) => `${n} neutral` },
  fieldChip: {
    pl: (rel: Rel, k: number) => `${plCount(k, "notatka", "notatki", "notatek")} ${plForm(k, PL_VERB[rel][0], PL_VERB[rel][1], PL_VERB[rel][0])}`,
    en: (rel: Rel, k: number) => `${enCount(k, "note", "notes")} ${enForm(k, EN_VERB[rel][0], EN_VERB[rel][1])}`,
  },

  // candidates
  /** The word a criterion threshold starts with (an agent may write it already). */
  threshold: { pl: (t: string) => `próg ${t}`, en: (t: string) => `threshold ${t}` },

  // research signals
  macro: { pl: "makro", en: "macro" },
  topic: { pl: "temat", en: "topic" },
  strength: { pl: (v: number) => `siła ${v}/3`, en: (v: number) => `strength ${v}/3` },
  nSources: { pl: (n: number) => plCount(n, "źródło", "źródła", "źródeł"), en: (n: number) => enCount(n, "source", "sources") },

  // run tag
  neverRan: { pl: "jeszcze nie działał", en: "hasn't run yet" },
  running: { pl: (hm: string) => `trwa · od ${hm}`, en: (hm: string) => `running · since ${hm}` },
  interrupted: {
    pl: (hm: string, notes: number | null) => `przerwany ${hm}${notes ? ` · ${plCount(notes, "notatka zapisana", "notatki zapisane", "notatek zapisanych")}` : ""}`,
    en: (hm: string, notes: number | null) => `interrupted ${hm}${notes ? ` · ${enCount(notes, "note", "notes")} saved` : ""}`,
  },
  staleRun: { pl: (d: string) => `brak w tym tygodniu · ostatni ${d}`, en: (d: string) => `none this week · last ${d}` },

  // note rows
  relFulfills: { pl: "spełnia tezę", en: "fulfills the thesis" },
  relSupports: { pl: "wzmacnia tezę", en: "supports the thesis" },
  relWeakens: { pl: "osłabia tezę", en: "weakens the thesis" },
  relInvalidates: { pl: "podważa tezę", en: "invalidates the thesis" },
  relNone: { pl: "nie dotyczy tezy", en: "doesn't concern the thesis" },
  community: { pl: "społeczność", en: "community" },
  dismissedOn: { pl: (d: string) => `odrzucona ${d}`, en: (d: string) => `dismissed ${d}` },
  expiredOn: { pl: (d: string) => `wygasła ${d}`, en: (d: string) => `expired ${d}` },
  predatesThesis: { pl: "sprzed zmiany tezy", en: "from before the thesis change" },
});
