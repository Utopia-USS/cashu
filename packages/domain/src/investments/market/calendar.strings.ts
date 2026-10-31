/**
 * UI texts of the market calendar (`market/calendar.py`), Polish and English. The Polish release
 * names are also what the calendar cache stores as a row's `title` (the cache keeps Polish titles
 * whatever the UI language), so they stay byte-equal to the Python source.
 */

/** Feed country code -> label; other countries' releases are left out (`COUNTRIES` / `COUNTRIES_EN`). */
export const countryLabels = {
  USD: { pl: "USA", en: "US" },
  EUR: { pl: "strefa euro", en: "euro area" },
  GBP: { pl: "Wielka Brytania", en: "UK" },
  JPY: { pl: "Japonia", en: "Japan" },
  CNY: { pl: "Chiny", en: "China" },
} as const;

/** Feed country code -> central bank (`CENTRAL_BANKS` / `CENTRAL_BANKS_EN`). */
export const centralBanks = {
  USD: { pl: "Fed", en: "Fed" },
  EUR: { pl: "EBC", en: "ECB" },
  GBP: { pl: "BoE", en: "BoE" },
  JPY: { pl: "BoJ", en: "BoJ" },
  CNY: { pl: "LBC", en: "PBoC" },
} as const;

/** Names of the common high-impact releases (`RELEASES` / `RELEASES_EN`), keyed by a stable id. */
export const releaseNames = {
  minutes: { pl: "protokół z posiedzenia banku centralnego", en: "central bank meeting minutes" },
  labor: { pl: "rynek pracy", en: "labor market" },
  pce: { pl: "inflacja PCE", en: "PCE inflation" },
  cpi: { pl: "inflacja CPI", en: "CPI inflation" },
  ppi: { pl: "inflacja producencka PPI", en: "PPI producer inflation" },
  gdp: { pl: "PKB", en: "GDP" },
  retail: { pl: "sprzedaż detaliczna", en: "retail sales" },
  pmiManufacturing: { pl: "PMI przemysł", en: "manufacturing PMI" },
  pmiServices: { pl: "PMI usługi", en: "services PMI" },
  speech: { pl: "wystąpienie szefa banku centralnego", en: "central bank chief speaks" },
  budget: { pl: "budżet państwa", en: "government budget" },
} as const;

export const calendarStrings = {
  rateDecision: {
    pl: (bank: string) => `${bank}: decyzja o stopach`,
    en: (bank: string) => `${bank}: rate decision`,
  },
  beforeOpen: { pl: "przed sesją", en: "before the open" },
  afterClose: { pl: "po sesji", en: "after the close" },
  quarterlyResults: {
    pl: (label: string) => `Wyniki kwartalne ${label}`,
    en: (label: string) => `Quarterly results ${label}`,
  },
} as const;
