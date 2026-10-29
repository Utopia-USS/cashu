// Texts of the research strip (src/modules/investments/v2/research/Strip.tsx). See src/i18n.ts.
import { catalog } from "../../../../i18n.ts";

export const S = catalog({
  research: { pl: "Research", en: "Research" },
  openNotes: { pl: "otwórz notatki", en: "open notes" },
  routine: { pl: "rutyna:", en: "routine:" },
  saturday: { pl: "sobota 07:00", en: "Saturday 07:00" },
  running: { pl: "przebieg trwa…", en: "run in progress…" },
  next: { pl: (d: string) => `następny ${d} · rutyna Claude Code`, en: (d: string) => `next ${d} · Claude Code routine` },
  runAgain: { pl: "Uruchom ponownie", en: "Run again" },
  all: { pl: "wszystkie", en: "all" },
  candidates: { pl: "Kandydaci", en: "Candidates" },
  newByStrategy: { pl: (v: string) => `nowi wg strategii${v}`, en: (v: string) => `new by the strategy${v}` },
  allCandidates: { pl: (n: number) => `wszyscy (${n})`, en: (n: number) => `all (${n})` },
  noCandidates: { pl: "Brak nowych kandydatów.", en: "No new candidates." },
  researchOn: { pl: (d: string) => `research ${d}`, en: (d: string) => `research ${d}` },
  noNotes: { pl: "bez notatek", en: "no notes" },
  noTopicData: { pl: "Brak danych tematów.", en: "No topic data." },
  noTopics: { pl: "Brak tematów.", en: "No topics." },
  topics: { pl: "Tematy", en: "Topics" },
  week: { pl: "· tydzień", en: "· week" },
  routineNotRun: { pl: "Rutyna nie uruchomiła się.", en: "The routine didn't run." },
  lastResearch: { pl: (d: string) => `ostatni research ${d}`, en: (d: string) => `last research ${d}` },
  valid: {
    pl: (n: number, until: string | null) => ` · ważnych ${n}${until ? ` do ${until}` : ""}`,
    en: (n: number, until: string | null) => ` · ${n} valid${until ? ` until ${until}` : ""}`,
  },
  scheduleIn: { pl: "Zaplanuj w Claude Code", en: "Schedule in Claude Code" },
});
