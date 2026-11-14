// Accessible texts of the phone's feedback components (packages/ui/src/feedback). See
// docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  /** ProgressDots: the accessible value, "2 of 5". */
  stepOf: {
    pl: (done: number, total: number) => `${done} z ${total}`,
    en: (done: number, total: number) => `${done} of ${total}`,
  },
});
