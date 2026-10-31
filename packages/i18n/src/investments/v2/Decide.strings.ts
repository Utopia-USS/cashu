// Texts of the position decision dialog (frontend/src/modules/investments/v2/Decide.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  exitPlan: { pl: "Plan wyjścia", en: "Exit plan" },
  thesis: { pl: "Teza", en: "Thesis" },
  dialogLabel: {
    pl: (name: string) => `Decyzja · ${name}`,
    en: (name: string) => `Decision · ${name}`,
  },
  decision: { pl: "Decyzja", en: "Decision" },
  closeEsc: { pl: "Zamknij (Esc)", en: "Close (Esc)" },
  openSignals: { pl: "otwarte sygnały", en: "open signals" },
  noOpenSignals: { pl: "bez otwartych sygnałów", en: "no open signals" },
});
