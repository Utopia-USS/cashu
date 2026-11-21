// List benchmark screen of the scaffold (S41, S50 method). PL + EN.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Pomiar listy", en: "List benchmark" },
  rows: {
    pl: (n: string) => `${n} transakcji z magazynu`,
    en: (n: string) => `${n} transactions from the store`,
  },
  scroll4k: { pl: "Przewiń 4k", en: "Scroll 4k" },
  scroll12k: { pl: "Przewiń 12k", en: "Scroll 12k" },
  mount500: { pl: "Zamontuj 500", en: "Mount 500" },
  uncategorized: { pl: "bez kategorii", en: "uncategorized" },
});
