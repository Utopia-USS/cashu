// Texts of the macro widgets (frontend/src/modules/investments/v2/research/MacroWidgets.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../../../index.js";

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
});
