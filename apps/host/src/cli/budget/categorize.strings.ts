import { plCount, type TranslationVariants } from "@cashu/i18n";
export const S = {
  transferCleared: {
    pl: (count: number) => `Usunięto wcześniejsze grupowanie ${count} transakcji.`,
    en: (count: number) => `Cleared ${count} previously-grouped transactions.`,
  } satisfies TranslationVariants<(count: number) => string>,
  transferMatched: {
    pl: (count: number) =>
      `Dopasowano ${plCount(count, "parę", "pary", "par")} przelewów wewnętrznych.`,
    en: (count: number) => `Matched ${count} internal-transfer pair(s).`,
  } satisfies TranslationVariants<(count: number) => string>,
  categorized: {
    pl: (count: number) =>
      `Skategoryzowano ${plCount(count, "transakcję", "transakcje", "transakcji")}.`,
    en: (count: number) => `Categorized ${count} transactions.`,
  } satisfies TranslationVariants<(count: number) => string>,
  categoryPinned: {
    pl: (merchant: string, category: string, count: number) =>
      `${merchant} → ${category} (${plCount(count, "transakcja", "transakcje", "transakcji")})`,
    en: (merchant: string, category: string, count: number) =>
      `${merchant} → ${category} (${count} transactions)`,
  } satisfies TranslationVariants<(merchant: string, category: string, count: number) => string>,
  cloudRisk: {
    pl: "Kategoryzacja w chmurze wysyła do Anthropic dopuszczone nazwy sprzedawców z płatności kartą. Nazwa sprzedawcy może zawierać imię i nazwisko osoby prowadzącej firmę. Dodatkowe szczegóły transakcji nie są dołączane. Domyślnie działa lokalna Ollama.",
    en: "Cloud categorization sends eligible merchant names from card payments to Anthropic. A merchant name may include the personal name of a sole trader. No additional transaction details are included. Local Ollama remains the default.",
  } satisfies TranslationVariants<string>,
  cloudUnavailable: {
    pl: "Kategoryzacja w chmurze jest niedostępna: potrzebne są aktualne uprawnienia, potwierdzona zgoda dla tego profilu i dane dostępowe.",
    en: "Cloud categorization is unavailable: current authority, reviewed consent for this profile and credentials are required.",
  } satisfies TranslationVariants<string>,
  cloudEmpty: {
    pl: "Pominięto kategoryzację w chmurze: brak poprawnych odpowiedzi modelu.",
    en: "Cloud categorization skipped: no valid model answers.",
  } satisfies TranslationVariants<string>,
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
