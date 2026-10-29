// Texts of the setup step helpers (src/core/setupSteps.ts), also the step count tag of SetupPage. See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  /** "2 z 3 kroków" (the Polish copy keeps "kroków" for every n but 1). */
  stepsOf: {
    pl: (done: number, n: number) => `${done} z ${n} ${n === 1 ? "kroku" : "kroków"}`,
    en: (done: number, n: number) => `${done} of ${n} ${n === 1 ? "step" : "steps"}`,
  },
  next: { pl: (step: string) => ` · następny: ${step}`, en: (step: string) => ` · next: ${step}` },
});
