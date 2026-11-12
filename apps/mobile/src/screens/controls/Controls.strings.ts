import { catalog } from "@cashu/i18n";

export const S = catalog({
  currency: { pl: "Waluta", en: "Currency" },
  account: { pl: "Konto", en: "Account" },
  noCurrencies: { pl: "Brak walut", en: "No currencies" },
  period: { pl: "Okres", en: "Period" },
  all: { pl: "Cała historia", en: "All history" },
  year: { pl: "Rok", en: "Year" },
  quarter: { pl: "Kwartał", en: "Quarter" },
  month: { pl: "Miesiąc", en: "Month" },
  previous: { pl: "Poprzedni okres", en: "Previous period" },
  next: { pl: "Następny okres", en: "Next period" },
  quarterValue: {
    pl: (quarter: number, year: number) => `${quarter}. kwartał ${year}`,
    en: (quarter: number, year: number) => `Q${quarter} ${year}`,
  },
});
