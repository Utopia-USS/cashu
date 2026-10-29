// Texts of the net worth over time widget (src/core/overview/NetWorthWidget.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  year: { pl: "1R", en: "1Y" },
  netWorthLower: { pl: "wartość netto", en: "net worth" },
  title: { pl: "Wartość netto w czasie", en: "Net worth over time" },
  chartKind: { pl: "Rodzaj wykresu", en: "Chart type" },
  line: { pl: "Linia", en: "Line" },
  stacked: { pl: "Warstwy", en: "Layers" },
  scope: { pl: "Zakres majątku", en: "Asset scope" },
  scopeTotal: { pl: "Całość (z nieruchomością)", en: "Total (with property)" },
  scopeLiquid: { pl: "Płynne (tylko konta)", en: "Liquid (accounts only)" },
  range: { pl: "Zakres czasu", en: "Time range" },
  months12: { pl: "12 mies. ", en: "12 mo. " },
  noProperty: { pl: "bez nieruchomości ", en: "without property " },
  step: { pl: "Krok wykresu", en: "Chart step" },
  monthly: { pl: "miesięcznie", en: "monthly" },
  weekly: { pl: "tygodniowo", en: "weekly" },
  daily: { pl: "dziennie", en: "daily" },
  empty: { pl: "Brak danych: dodaj konta lub pozycje.", en: "No data: add accounts or positions." },
  lineLabel: { pl: (c: string) => `Wartość netto w czasie, ${c}`, en: (c: string) => `Net worth over time, ${c}` },
  stackedLabel: { pl: (c: string) => `Składniki wartości netto, ${c}`, en: (c: string) => `Net worth components, ${c}` },
});
