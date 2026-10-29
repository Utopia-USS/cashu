// Texts of the macro widgets (src/modules/investments/v2/research/MacroWidgets.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../../i18n.ts";

export const S = catalog({
  macro: { pl: "Makro", en: "Macro" },
  lastSession: { pl: "ostatnia sesja w danych", en: "last session in the data" },
  stateOn: { pl: (d: string) => `stan ${d}`, en: (d: string) => `as of ${d}` },
  noData: { pl: "brak danych", en: "no data" },
  lastQuote: { pl: "ostatnie notowanie w danych", en: "last quote in the data" },
  nNewNotes: {
    pl: (n: number) => plCount(n, "nowa notatka", "nowe notatki", "nowych notatek"),
    en: (n: number) => enCount(n, "new note", "new notes"),
  },
  supports: { pl: "Co sprzyja", en: "Tailwinds" },
  risks: { pl: "Na co uważać", en: "Watch out for" },
  nChanges: { pl: (n: number) => plCount(n, "zmiana", "zmiany", "zmian"), en: (n: number) => enCount(n, "change", "changes") },
  fromTo: { pl: (from: string) => `: z ${from} na `, en: (from: string) => `: from ${from} to ` },
  since: { pl: (d: string) => `· od ${d}`, en: (d: string) => `· since ${d}` },
});
