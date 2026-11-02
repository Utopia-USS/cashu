import type { TranslationVariants } from "@cashu/i18n";
export const S = {
  authorityChanged: {
    pl: "Nie zastosowano odpowiedzi modelu: zmienił się profil lub uprawnienie do pobierania.",
    en: "The model answers were not applied: the profile or fetch authority changed.",
  } satisfies TranslationVariants<string>,
  unsupportedFallback: {
    pl: "Ta część ponownej kategoryzacji nie jest jeszcze obsługiwana. Nie zmieniono kategorii.",
    en: "This reclassification fallback is not supported yet. No categories were changed.",
  } satisfies TranslationVariants<string>,
  contextChanged: {
    pl: "Dane transakcji zmieniły się podczas kategoryzacji. Nie zastosowano odpowiedzi modelu.",
    en: "The transaction context changed during classification. No model answers were applied.",
  } satisfies TranslationVariants<string>,
} as const;
