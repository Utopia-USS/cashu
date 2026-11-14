// Texts of the undo flows (frontend/src/modules/investments/v2/undoFlow.ts). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  undone: { pl: (what: string) => `Cofnięto: ${what}`, en: (what: string) => `Undone: ${what}` },
  alreadyListed: { pl: "Już na liście", en: "Already on the list" },
  notRestored: {
    pl: (detail: string) => `Nie przywrócono: ${detail}`,
    en: (detail: string) => `Not restored: ${detail}`,
  },
  undoFailed: {
    pl: (what: string) => `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`,
    en: (what: string) => `Couldn't undo: ${what} - try again`,
  },
});
