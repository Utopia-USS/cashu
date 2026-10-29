// Texts of the market segments / topics (src/modules/investments/v2/research/segments.ts). See src/i18n.ts.
import { catalog } from "../../../../i18n.ts";

/** Topic catalog labels (the backend's INV/research/segments.py renders the same labels for its payloads). */
export const SEGMENT_LABEL = catalog({
  equity_global: { pl: "Akcje globalne", en: "Global equities" },
  equity_pl: { pl: "Akcje polskie", en: "Polish equities" },
  equity_em: { pl: "Rynki wschodzące", en: "Emerging markets" },
  bonds: { pl: "Obligacje i stopy", en: "Bonds and rates" },
  gold: { pl: "Złoto i górnicy", en: "Gold and miners" },
  energy: { pl: "Ropa i gaz", en: "Oil and gas" },
  power: { pl: "Energetyka: atom i OZE", en: "Power: nuclear and renewables" },
  metals: { pl: "Metale i ziemie rzadkie", en: "Metals and rare earths" },
  crypto: { pl: "Krypto", en: "Crypto" },
  real_estate: { pl: "Nieruchomości", en: "Real estate" },
  semis_ai: { pl: "AI: chipy i centra danych", en: "AI: chips and data centers" },
  software: { pl: "AI i oprogramowanie", en: "AI and software" },
  robotics: { pl: "Robotyka", en: "Robotics" },
  healthcare: { pl: "Ochrona zdrowia", en: "Healthcare" },
  financials: { pl: "Płatności i finanse", en: "Payments and finance" },
  consumer: { pl: "Konsumpcja", en: "Consumer" },
  games_media: { pl: "Gry", en: "Games" },
  industrials: { pl: "Przemysł i obronność", en: "Industrials and defense" },
  quantum: { pl: "Komputery kwantowe", en: "Quantum computing" },
});

export const S = catalog({
  barTitle: { pl: (c: string, scale: string) => `wkład ${c} · skala ±${scale}`, en: (c: string, scale: string) => `contribution ${c} · scale ±${scale}` },
  staleQuotes: { pl: (syms: string) => `notowania nieaktualne: ${syms}`, en: (syms: string) => `stale quotes: ${syms}` },
  residual: { pl: (pp: string) => `reszta ${pp}: transakcje i import pozycji`, en: (pp: string) => `remainder ${pp}: transactions and position imports` },
  windowTitle: {
    pl: (from: string, to: string, partial: boolean) => `${from} - ${to} · TWR portfela${partial ? " · brak pełnej historii" : ""}`,
    en: (from: string, to: string, partial: boolean) => `${from} - ${to} · portfolio TWR${partial ? " · incomplete history" : ""}`,
  },
  watchedOnly: { pl: "tylko obserwowane", en: "watchlist only" },
  newInWindow: { pl: "nowa pozycja w tym oknie", en: "new position in this window" },
  source: { pl: "źródło", en: "source" },
  sources: { pl: (names: string) => `Źródła: ${names}`, en: (names: string) => `Sources: ${names}` },
});
