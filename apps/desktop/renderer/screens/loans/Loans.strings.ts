import { catalog } from "@cashu/i18n";
export const L = catalog({
  chartSummary: {
    pl: (latest: string, low: string, high: string) =>
      `Ostatnie saldo ${latest}; minimum ${low}; maksimum ${high}`,
    en: (latest: string, low: string, high: string) =>
      `Latest balance ${latest}; low ${low}; high ${high}`,
  },
  title: { pl: "Kredyty", en: "Loans" },
  positions: { pl: (n: number) => `Pozycje: ${n}`, en: (n: number) => `Positions: ${n}` },
  overview: { pl: "Przegląd", en: "Overview" },
  add: { pl: "Dodaj kredyt", en: "Add loan" },
  payments: { pl: "Rozpoznawanie rat", en: "Recognize installments" },
  empty: {
    pl: "Dodaj kredyt, aby zobaczyć harmonogram spłat.",
    en: "Add a loan to see its repayment schedule.",
  },
  invalid: {
    pl: "Sprawdź nazwę, kwoty, oprocentowanie, okres i daty.",
    en: "Check the name, amounts, interest rate, term and dates.",
  },
  taken: { pl: "Kredyt o tej nazwie już istnieje.", en: "A loan with this name already exists." },
  refused: {
    pl: "Nie zapisano zmian. Sprawdź dane i spróbuj ponownie.",
    en: "Changes were not saved. Check the details and try again.",
  },
  invalidPayment: {
    pl: "Podaj poprawną frazę lub numer rachunku.",
    en: "Enter a valid phrase or account number.",
  },
  matched: {
    pl: (n: number) => `Dopasowane raty: ${n}`,
    en: (n: number) => `Matched installments: ${n}`,
  },
  cleared: { pl: "Usunięto regułę rozpoznawania rat.", en: "Installment matching rule cleared." },
  max: { pl: "Całość", en: "All" },
  years: { pl: (n: number) => `${n} lat`, en: (n: number) => `${n} years` },
  chartRange: { pl: "Zakres wykresu", en: "Chart range" },
  choose: { pl: "Wybierz kredyt", en: "Choose loan" },
  setup: { pl: "Pierwsze kroki", en: "First steps" },
  optional: { pl: "Opcjonalnie", en: "Optional" },
  ready: { pl: "Gotowe", en: "Done" },
  notReady: { pl: "Do zrobienia", en: "To do" },
  hidden: { pl: "Ukryte", en: "Hidden" },
  preview: { pl: "Szacowana rata", en: "Estimated installment" },
  previous: { pl: "Poprzednia strona", en: "Previous page" },
  next: { pl: "Następna strona", en: "Next page" },
});
