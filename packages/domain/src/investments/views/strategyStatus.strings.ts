/** User-facing strategy read diagnostics. */
export const strategyStatusStrings = {
  baseMismatch: {
    en: (strategy: string, profile: string) =>
      `strategy base_currency ${strategy} differs from the profile's ${profile}`,
    pl: (strategy: string, profile: string) =>
      `Waluta bazowa strategii ${strategy} różni się od waluty profilu ${profile}`,
  },
} as const;
