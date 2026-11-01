// Texts the host's CLI runner prints itself (PL + EN, docs/agents/localization.md), resolved with the
// command's own Translator (its CASHU_LANG / locale, settings.json, the OS).
import type { TranslationVariants } from "@cashu/i18n";

export const S = {
  pythonMissing: {
    pl: "Tego polecenia nie przeniesiono jeszcze do nowej części cashU, a części w Pythonie nie znaleziono.",
    en: "This command has not moved to the new part of cashU yet, and the Python part was not found.",
  } satisfies TranslationVariants<string>,
  busy: {
    pl: "Ta sesja wykonuje już polecenie.",
    en: "This session is already running a command.",
  } satisfies TranslationVariants<string>,
} as const;
