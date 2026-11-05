// Texts the native Wydatki port adds to the old catalogs (@cashu/i18n budget/*.strings): privacy-mode wording.
import { catalog } from "@cashu/i18n";

export const E = catalog({
  /** The toast action in privacy mode (the old label names the merchant: "Wszystkie od ..."). */
  allFromMerchant: { pl: "Wszystkie od tego sprzedawcy", en: "All from this merchant" },
  /** The plan fact when the contribution plan cannot be read here (native: no strategy source). */
  planUnavailable: { pl: "porównanie niedostępne", en: "comparison unavailable" },
});
