// Texts of the investments module definition (index.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  name: { pl: "Inwestycje", en: "Investments" },
  desc: { pl: "Rachunki maklerskie, alokacja vs strategia, sygnały, dziennik decyzji", en: "Brokerage accounts, allocation vs strategy, signals, decision journal" },
  hint: { pl: "Konfiguracja przez skill w Claude Code.", en: "Set up through a skill in Claude Code." },
  short: { pl: "Rachunki maklerskie, alokacja vs strategia, sygnały i dziennik decyzji", en: "Brokerage accounts, allocation vs strategy, signals and decision journal" },
  skillHint: { pl: "Wywiad: ok. 1,5-2 h, można przerwać i wrócić.", en: "Interview: about 1.5-2 h, you can pause and come back." },
  tab: { pl: "Inwestycje", en: "Investments" },
  kpiPortfolio: { pl: "Portfel inwestycji", en: "Investment portfolio" },
  kpiPortfolioIn: { pl: (base: string) => `Portfel inwestycji (${base})`, en: (base: string) => `Investment portfolio (${base})` },
  noPositions: { pl: "brak pozycji", en: "no positions" },
  notConfigured: { pl: "moduł nieskonfigurowany", en: "module not set up" },
  open: { pl: "otwórz", en: "open" },
  configure: { pl: "skonfiguruj", en: "set up" },
  fromCost: { pl: (p: string) => `${p} od kosztu`, en: (p: string) => `${p} from cost` },
  factValue: { pl: "Wartość portfela", en: "Portfolio value" },
  factSignals: { pl: "Sygnały", en: "Signals" },
  signalsBoth: {
    pl: (action: number, info: number) => `${action} do działania · ${info} do przeglądu`,
    en: (action: number, info: number) => `${action} to act on · ${info} to review`,
  },
  signalsInfo: { pl: (info: number) => `${info} do przeglądu`, en: (info: number) => `${info} to review` },
  factRules: { pl: "Reguły", en: "Rules" },
});
