import type { TranslationVariants } from "@cashu/i18n";

/** Texts of `cashu remove-account` / `cashu restore-account` (bank accounts only). */
export const R = {
  usage: {
    pl: (command: string) => `Użycie: cashu ${command} ACCOUNT_GID`,
    en: (command: string) => `Usage: cashu ${command} ACCOUNT_GID`,
  },
  noBankAccount: {
    pl: (gid: string) =>
      `Konto ${gid} nie jest kontem bankowym (osobiste, oszczędnościowe, karta kredytowa) wybranego profilu.`,
    en: (gid: string) =>
      `Account ${gid} is not a bank account (checking, savings, credit card) of the selected profile.`,
  },
  removed: {
    pl: (gid: string) =>
      `Usunięto konto ${gid} z widoku i z budżetu. Przywrócisz je razem z historią poleceniem cashu restore-account ${gid}.`,
    en: (gid: string) =>
      `Removed account ${gid} from view and from the budget. Bring it back with its history using cashu restore-account ${gid}.`,
  },
  restored: {
    pl: (gid: string) => `Przywrócono konto ${gid}.`,
    en: (gid: string) => `Restored account ${gid}.`,
  },
} satisfies Record<string, TranslationVariants<unknown>>;
