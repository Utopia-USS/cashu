/**
 * UI texts of the investments' blank-page steps (`modules/investments/setup.py`), Polish and English,
 * byte-equal to the Python source (parity check `core.overview`).
 */

export const investmentsSetupStrings = {
  accountTitle: { pl: "Dodaj rachunek maklerski", en: "Add a brokerage account" },
  accountDescription: {
    pl: "Broker + opakowanie (zwykłe, IKE, IKZE).",
    en: "Broker + wrapper (regular, IKE, IKZE).",
  },
  strategyTitle: { pl: "Zapisz strategię", en: "Save the strategy" },
  strategyDescription: {
    pl: "strategy.yaml i strategy.md; wywiad w Claude Code albo szablon.",
    en: "strategy.yaml and strategy.md; an interview in Claude Code or a template.",
  },
  strategyTemplate: { pl: "Utwórz z szablonu", en: "Create from a template" },
  importTitle: { pl: "Pierwsza wpłata lub import", en: "First contribution or import" },
  importDescription: {
    pl: "Plik od brokera (format cashU albo CSV).",
    en: "A file from your broker (cashU format or CSV).",
  },
  importArgs: {
    pl: "invest import PLIK.csv --account ID_RACHUNKU",
    en: "invest import FILE.csv --account ACCOUNT_ID",
  },
  runTitle: { pl: "Pierwszy przebieg reguł", en: "First rules run" },
  runDescription: { pl: "Wycena, alokacja, sygnały.", en: "Valuation, allocation, signals." },
} as const;
