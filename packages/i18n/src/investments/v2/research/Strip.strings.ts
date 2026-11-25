// Texts of the research strip (frontend/src/modules/investments/v2/research/Strip.tsx). See docs/agents/localization.md.
import { catalog, plForm } from "../../../index.js";

export const S = catalog({
  candidates: { pl: "Kandydaci", en: "Candidates" },
  allCandidates: { pl: (n: number) => `wszyscy (${n})`, en: (n: number) => `all (${n})` },
  noCandidates: { pl: "Brak nowych kandydatów.", en: "No new candidates." },
  candidatesLead: {
    pl: (n: number) =>
      `${n === 1 ? "Jedna spółka" : `${n} ${plForm(n, "spółka", "spółki", "spółek")}`} spoza listy ${plForm(n, "pasuje", "pasują", "pasuje")} do Twoich kryteriów wejścia.`,
    en: (n: number) =>
      `${n === 1 ? "One company" : `${n} companies`} outside your list ${n === 1 ? "fits" : "fit"} your entry criteria.`,
  },
  whyFits: { pl: "Dlaczego pasuje", en: "Why it fits" },
  whyFitsAria: {
    pl: (name: string) => `Dlaczego ${name} pasuje`,
    en: (name: string) => `Why ${name} fits`,
  },
  watching: { pl: "Obserwujesz", en: "Watching" },
  dismissTitle: { pl: "Odrzuć", en: "Dismiss" },
});
