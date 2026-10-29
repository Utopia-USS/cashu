// Texts of the undo flows (src/modules/investments/v2/undoFlow.ts). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

export const S = catalog({
  undone: { pl: (what: string) => `Cofnięto: ${what}`, en: (what: string) => `Undone: ${what}` },
  alreadyListed: { pl: "Już na liście", en: "Already on the list" },
  notRestored: { pl: (detail: string) => `Nie przywrócono: ${detail}`, en: (detail: string) => `Not restored: ${detail}` },
  undoFailed: { pl: (what: string) => `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`, en: (what: string) => `Couldn't undo: ${what} - try again` },
});
