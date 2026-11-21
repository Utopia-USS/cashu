// Native-only texts of the Kredyty screen (command outcomes, the chart's screen-reader summary); the old tab,
// drawers and first steps texts are the legacy catalogs in @cashu/i18n/loans.
import { catalog } from "@cashu/i18n";
export const L = catalog({
  chartSummary: {
    pl: (latest: string, low: string, high: string) =>
      `Ostatnie saldo ${latest}; minimum ${low}; maksimum ${high}`,
    en: (latest: string, low: string, high: string) =>
      `Latest balance ${latest}; low ${low}; high ${high}`,
  },
  invalid: {
    pl: "Sprawdź nazwę, kwoty, oprocentowanie, okres i daty.",
    en: "Check the name, amounts, interest rate, term and dates.",
  },
  refused: {
    pl: "Nie zapisano zmian. Sprawdź dane i spróbuj ponownie.",
    en: "Changes were not saved. Check the details and try again.",
  },
  invalidPayment: {
    pl: "Podaj poprawną frazę lub numer rachunku.",
    en: "Enter a valid phrase or account number.",
  },
});
