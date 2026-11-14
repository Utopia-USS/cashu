import type { TranslationVariants } from "@cashu/i18n";

export const S = {
  off: { pl: "Reguła poduszki: wyłączona", en: "Cushion rule: off" },
  months: {
    pl: (n: number) => `${n} mies. średnich wydatków`,
    en: (n: number) => `${n} months of average spending`,
  },
  savingsAccounts: { pl: "konta oszczędnościowe", en: "savings accounts" },
  base: { pl: "bazowa", en: "base" },
  none: { pl: "brak", en: "none" },
  on: {
    pl: (target: string, currency: string, accounts: string, monthlyMax: string) =>
      `Reguła poduszki: włączona, cel ${target}, waluta ${currency}, konta ${accounts}, miesięczny limit ${monthlyMax}`,
    en: (target: string, currency: string, accounts: string, monthlyMax: string) =>
      `Cushion rule: on, target ${target}, currency ${currency}, accounts ${accounts}, monthly max ${monthlyMax}`,
  },
  unknownAccount: {
    pl: "--account musi wskazywać widoczne konto w wybranym profilu.",
    en: "--account must identify a visible account in the selected profile.",
  },
} satisfies Record<string, TranslationVariants<unknown>>;
