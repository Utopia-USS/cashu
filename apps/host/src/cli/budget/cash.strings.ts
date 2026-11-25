import type { TranslationVariants } from "@cashu/i18n";

/** `cashu cash-add` refusals the command names itself (anything else goes through the generic line). */
export const S = {
  /** `cash_currency_mismatch`: the cash pool of that currency is kept in another one (malformed data). */
  currencyMismatch: {
    pl: "Portfel gotówkowy w tej walucie jest prowadzony w innej walucie, więc wydatku nie zapisano.",
    en: "The cash wallet for this currency is kept in another currency, so the expense was not saved.",
  },
} satisfies Record<string, TranslationVariants<unknown>>;
