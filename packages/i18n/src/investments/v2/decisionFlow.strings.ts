// Texts of the position decision flow (frontend/src/modules/investments/v2/decisionFlow.ts). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  signalClosed: { pl: "Sygnał już zamknięty", en: "The signal is already closed" },
  otherInstrument: {
    pl: "Sygnał dotyczy innego instrumentu",
    en: "The signal is about another instrument",
  },
});
