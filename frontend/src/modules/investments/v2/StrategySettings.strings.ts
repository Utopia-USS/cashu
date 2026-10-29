// Texts of the investment strategy card in Settings (StrategySettings.tsx). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

export const S = catalog({
  title: { pl: "Strategia inwestycji", en: "Investment strategy" },
  created: { pl: "Utworzono strategię z szablonu", en: "Strategy created from the template" },
  createFailed: { pl: (err: string) => `Nie utworzono strategii: ${err}`, en: (err: string) => `Strategy not created: ${err}` },
  loaded: { pl: (v: number) => `Strategia wczytana · v${v}`, en: (v: number) => `Strategy loaded · v${v}` },
  noFile: { pl: "Brak pliku strategii", en: "No strategy file" },
  loadFailed: { pl: (err: string) => `Nie wczytano strategii: ${err}`, en: (err: string) => `Strategy not loaded: ${err}` },
  approved: {
    pl: (v: number | null | undefined) => `Zatwierdzono propozycję${v ? ` · strategia v${v}` : ""}`,
    en: (v: number | null | undefined) => `Proposal approved${v ? ` · strategy v${v}` : ""}`,
  },
  rejected: { pl: "Odrzucono propozycję", en: "Proposal rejected" },
});
