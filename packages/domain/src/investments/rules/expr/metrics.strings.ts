/** Missing-data reasons of expression metrics, in the Python UI languages. */
export const metricStrings = {
  staleWeight: { pl: "Udział nieaktualnych cen nieznany", en: "Stale price share unknown" },
  unclassifiedWeight: {
    pl: "Udział pozycji bez koszyka nieznany",
    en: "Share of positions without a bucket unknown",
  },
  maximumWeight: { pl: "Waga największej pozycji nieznana", en: "Largest position weight unknown" },
  noDeposits: { pl: "Brak zapisanych wpłat", en: "No contributions recorded" },
  tagWeight: { pl: "Waga tagów nieznana", en: "Tag weight unknown" },
  assetWeight: {
    pl: (asset: string) => `Waga klasy aktywów ${asset} nieznana`,
    en: (asset: string) => `Weight of asset class ${asset} unknown`,
  },
  noMic: {
    pl: (label: string) => `${label}: brak kodu giełdy (mic)`,
    en: (label: string) => `${label}: no exchange code (mic)`,
  },
  noWeight: {
    pl: (label: string) => `Brak wagi: ${label}`,
    en: (label: string) => `No weight: ${label}`,
  },
  noPrice: {
    pl: (label: string) => `Brak ceny: ${label}`,
    en: (label: string) => `No price: ${label}`,
  },
  noUnrealized: {
    pl: (label: string) => `Brak wyniku niezrealizowanego: ${label}`,
    en: (label: string) => `No unrealized result: ${label}`,
  },
  bucket: { pl: "koszyka", en: "bucket" },
  bucketWeight: {
    pl: (word: string) => `Waga ${word} nieznana`,
    en: (word: string) => `Weight of the ${word} unknown`,
  },
  bucketTarget: {
    pl: (word: string) => `Cel ${word} nieznany`,
    en: (word: string) => `Target of the ${word} unknown`,
  },
  bucketDrift: {
    pl: (word: string) => `Dryf ${word} nieznany`,
    en: (word: string) => `Drift of the ${word} unknown`,
  },
  bucketRelativeDrift: {
    pl: (word: string) => `Względny dryf ${word} nieokreślony (cel 0)`,
    en: (word: string) => `Relative drift of the ${word} undefined (target 0)`,
  },
} as const;
