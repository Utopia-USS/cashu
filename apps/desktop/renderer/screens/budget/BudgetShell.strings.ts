// Texts of the native budget shell that the Python app did not have (native-only states). PL + EN.
import { catalog } from "@cashu/i18n";

export const T = catalog({
  importUnavailable: {
    pl: "Import plików nie jest jeszcze dostępny w aplikacji.",
    en: "File import is not yet available in the app.",
  },
  unsupported: {
    pl: "Ta funkcja nie jest jeszcze dostępna.",
    en: "This feature is not yet available.",
  },
  synced: { pl: "Dane zostały odświeżone.", en: "Data refreshed." },
  setup: { pl: "Moduł budżetu jest wyłączony.", en: "The budget module is off." },
});
