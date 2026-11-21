// Texts of the setup step helpers (frontend/src/core/setupSteps.ts), also the step count tag of SetupPage. See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  /** "2 z 3 kroków" (the Polish copy keeps "kroków" for every n but 1). */
  stepsOf: {
    pl: (done: number, n: number) => `${done} z ${n} ${n === 1 ? "kroku" : "kroków"}`,
    en: (done: number, n: number) => `${done} of ${n} ${n === 1 ? "step" : "steps"}`,
  },
});
