// Texts of the instrument search (src/modules/investments/v2/searchLogic.ts). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

/** Short type word on the right of a search row. */
export const TYPE_WORD_L = catalog({
  etf: { pl: "ETF", en: "ETF" },
  equity: { pl: "akcja", en: "stock" },
  fund: { pl: "fundusz", en: "fund" },
  crypto: { pl: "krypto", en: "crypto" },
});

export const S = catalog({
  index: { pl: "indeks", en: "index" },
  watch: { pl: (sym: string) => `Obserwuj ${sym}`, en: (sym: string) => `Watch ${sym}` },
  watching: { pl: (sym: string) => `Obserwujesz ${sym}`, en: (sym: string) => `Watching ${sym}` },
  saved: { pl: "zapisany", en: "saved" },
  held: { pl: "w portfelu", en: "in the portfolio" },
  restored: { pl: (name: string) => `Przywrócono ${name}`, en: (name: string) => `Restored ${name}` },
  guessedSymbol: { pl: "symbol ceny zgadnięty, sprawdź, czy przyjdą notowania", en: "price symbol guessed, check that quotes arrive" },
});
