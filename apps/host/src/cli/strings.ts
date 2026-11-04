// Texts the host's CLI runner prints itself (PL + EN, docs/agents/localization.md), resolved with the
// command's own Translator (its CASHU_LANG / locale, settings.json, the OS).
import type { TranslationVariants } from "@cashu/i18n";

export const S = {
  unsupported: {
    pl: "Nieznane lub nieobsługiwane polecenie albo argumenty. Sprawdź składnię i spróbuj ponownie.",
    en: "Unknown or unsupported command or arguments. Check the syntax and try again.",
  } satisfies TranslationVariants<string>,
  busy: {
    pl: "Ta sesja wykonuje już polecenie.",
    en: "This session is already running a command.",
  } satisfies TranslationVariants<string>,
} as const;
