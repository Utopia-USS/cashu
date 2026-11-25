// Texts of the undo toasts (frontend/src/modules/investments/undo.ts). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  done: { pl: (what: string) => `Cofnięto: ${what}`, en: (what: string) => `Undone: ${what}` },
  expired: {
    pl: (minutes: number) => `Za późno na cofnięcie: minęło ${minutes} minut`,
    en: (minutes: number) => `Too late to undo: ${minutes} minutes have passed`,
  },
  failed: {
    pl: (what: string) => `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`,
    en: (what: string) => `Couldn't undo: ${what} - try again`,
  },
  gone: {
    pl: (what: string) => `Już cofnięte: ${what}`,
    en: (what: string) => `Already undone: ${what}`,
  },
  refused: {
    pl: (what: string) => `Nie da się cofnąć: ${what}`,
    en: (what: string) => `Can't undo: ${what}`,
  },
});
