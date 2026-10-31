// Texts of the search-to-add field (InstrumentSearch.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  alreadyListed: { pl: "Już na liście", en: "Already on the list" },
  placeholder: { pl: "Nazwa, symbol lub ISIN", en: "Name, symbol or ISIN" },
  searchAria: { pl: "Szukaj instrumentu", en: "Search for an instrument" },
  noResults: { pl: "Brak wyników", en: "No results" },
  results: { pl: "Wyniki", en: "Results" },
  addFree: { pl: (text: string) => `Dodaj „${text}”`, en: (text: string) => `Add "${text}"` },
  onlineUnavailable: { pl: "Wyszukiwanie online niedostępne", en: "Online search unavailable" },
  savedTitle: {
    pl: "Wróci z researchem i notatkami",
    en: "Comes back with its research and notes",
  },
  saved: { pl: "zapisany", en: "saved" },
  held: { pl: "w portfelu", en: "in portfolio" },
});
