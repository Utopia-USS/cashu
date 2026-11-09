// Texts of the net worth over time widget (frontend/src/core/overview/NetWorthWidget.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  year: { pl: "1R", en: "1Y" },
  netWorthLower: { pl: "wartość netto", en: "net worth" },
  title: { pl: "Wartość netto w czasie", en: "Net worth over time" },
  chartKind: { pl: "Rodzaj wykresu", en: "Chart type" },
  line: { pl: "Linia", en: "Line" },
  stacked: { pl: "Warstwy", en: "Layers" },
  scope: { pl: "Zakres majątku", en: "Asset scope" },
  scopeTotal: {
    pl: (beyond: readonly string[]) => `Całość: konta, ${beyond.join(", ")}`,
    en: (beyond: readonly string[]) => `Total: accounts, ${beyond.join(", ")}`,
  },
  scopeLiquid: { pl: "Płynne (tylko konta)", en: "Liquid (accounts only)" },
  range: { pl: "Zakres czasu", en: "Time range" },
  months12: { pl: "12 mies. ", en: "12 mo. " },
  accountsOnly: { pl: "tylko konta ", en: "accounts only " },
  historyFrom: {
    pl: (day: string) => `historia od ${day}: wcześniej część kont nie ma danych`,
    en: (day: string) => `history from ${day}: before that some accounts have no data`,
  },
  tooShort: {
    pl: (day: string) =>
      `Za krótka historia: część kont ma dane dopiero od ${day}. Wykres pojawi się z kolejnymi dniami.`,
    en: (day: string) =>
      `History too short: some accounts have data only from ${day}. The chart fills in over the next days.`,
  },
  step: { pl: "Krok wykresu", en: "Chart step" },
  monthly: { pl: "miesięcznie", en: "monthly" },
  weekly: { pl: "tygodniowo", en: "weekly" },
  daily: { pl: "dziennie", en: "daily" },
  empty: { pl: "Brak danych: dodaj konta lub pozycje.", en: "No data: add accounts or positions." },
  lineLabel: {
    pl: (c: string) => `Wartość netto w czasie, ${c}`,
    en: (c: string) => `Net worth over time, ${c}`,
  },
  composition: {
    pl: (assets: string, liabilities: string | null) =>
      liabilities ? `aktywa ${assets} · zobowiązania ${liabilities}` : `aktywa ${assets}`,
    en: (assets: string, liabilities: string | null) =>
      liabilities ? `assets ${assets} · liabilities ${liabilities}` : `assets ${assets}`,
  },
  stackedLabel: {
    pl: (c: string) => `Składniki wartości netto, ${c}`,
    en: (c: string) => `Net worth components, ${c}`,
  },
});
