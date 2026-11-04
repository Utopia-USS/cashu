import type { TranslationVariants } from "@cashu/i18n";

export const C = {
  selectProfile: {
    pl: "Wybierz profil przez --profile lub CASHU_PROFILE.",
    en: "Select a profile with --profile or CASHU_PROFILE.",
  },
  missingProfile: {
    pl: "Wybrany profil nie jest otwartym natywnym sejfem.",
    en: "Selected profile is not an open native vault.",
  },
  accountsUsage: { pl: "Użycie: cashu accounts", en: "Usage: cashu accounts" },
  accountUsage: {
    pl: (command: string) => `Użycie: cashu ${command} ACCOUNT_GID VALUE`,
    en: (command: string) => `Usage: cashu ${command} ACCOUNT_GID VALUE`,
  },
  balanceUsage: {
    pl: "Użycie: cashu set-balance ACCOUNT_GID VALUE [--date YYYY-MM-DD]",
    en: "Usage: cashu set-balance ACCOUNT_GID VALUE [--date YYYY-MM-DD]",
  },
  noAccount: {
    pl: (gid: string) => `Brak konta o GID ${gid} w wybranym profilu.`,
    en: (gid: string) => `No account with GID ${gid} in the selected profile.`,
  },
  nameRequired: { pl: "Nazwa konta jest wymagana.", en: "Account name is required." },
  accountRender: {
    pl: "Szerokość terminala lub tekst konta uniemożliwia bezpieczne wyświetlenie.",
    en: "Terminal width or account text cannot be rendered safely.",
  },
  accountsTitle: { pl: "Konta", en: "Accounts" },
  accountGid: {
    pl: (gid: string) => `GID ${gid}`,
    en: (gid: string) => `GID ${gid}`,
  },
  accountHeaders: {
    pl: ["gid", "bank", "nazwa", "iban", "typ", "waluta", "aktywne"],
    en: ["gid", "bank", "name", "iban", "type", "currency", "active"],
  },
  yes: { pl: "tak", en: "yes" },
  no: { pl: "nie", en: "no" },
  accountChanged: {
    pl: (gid: string) => `Zmieniono konto ${gid}.`,
    en: (gid: string) => `Updated account ${gid}.`,
  },
  accountBalanceChanged: {
    pl: (gid: string, value: string) => `Zapisano saldo konta ${gid}: ${value}.`,
    en: (gid: string, value: string) => `Recorded balance for account ${gid}: ${value}.`,
  },
  profileUsage: {
    pl: "Użycie: cashu profiles list|add|inspect ...",
    en: "Usage: cashu profiles list|add|inspect ...",
  },
  profileAddUsage: {
    pl: "Użycie: cashu profiles add NAME [--currency CODE] [--modules IDS] [--privacy strict|amounts]",
    en: "Usage: cashu profiles add NAME [--currency CODE] [--modules IDS] [--privacy strict|amounts]",
  },
  profileInspectUsage: {
    pl: "Użycie: cashu profiles inspect OPERATION_ID",
    en: "Usage: cashu profiles inspect OPERATION_ID",
  },
  inspectPending: {
    pl: (id: string, stage: string) => `Operacja ${id} trwa (${stage}).`,
    en: (id: string, stage: string) => `Operation ${id} is pending (${stage}).`,
  },
  inspectUnknown: {
    pl: (id: string, stage: string) =>
      `Wynik operacji ${id} jest nieznany (${stage}). Sprawdź ponownie przed nową próbą.`,
    en: (id: string, stage: string) =>
      `Operation ${id} has an unknown outcome (${stage}). Inspect again before a new attempt.`,
  },
  inspectReady: {
    pl: (id: string) => `Operacja ${id} zakończona. Połącz się ponownie, aby użyć profilu.`,
    en: (id: string) => `Operation ${id} is ready. Reconnect to use the profile.`,
  },
  inspectMissing: {
    pl: (id: string) => `Nie znaleziono operacji ${id}.`,
    en: (id: string) => `Operation ${id} was not found.`,
  },
  createTty: {
    pl: "Tworzenie profilu wymaga interaktywnego terminala do potwierdzenia frazy odzyskiwania.",
    en: "Profile creation requires an interactive terminal to confirm the recovery phrase.",
  },
  createUnavailable: {
    pl: "Tworzenie zaszyfrowanego profilu jest niedostępne w tej usłudze.",
    en: "Native encrypted profile creation is unavailable in this host.",
  },
  statusUnavailable: {
    pl: "Status tworzenia profilu jest niedostępny w tej usłudze.",
    en: "Native profile creation status is unavailable in this host.",
  },
  invalidProfile: {
    pl: "Nieprawidłowa nazwa profilu, waluta, moduły lub ustawienie prywatności.",
    en: "Invalid profile name, currency, modules or privacy setting.",
  },
  createRefused: {
    pl: (code: string) => `Odmowa utworzenia profilu: ${code}.`,
    en: (code: string) => `Profile creation refused: ${code}.`,
  },
  recoveryPhrase: {
    pl: (words: string) => `Fraza odzyskiwania (zapisz ją przed kontynuowaniem):\n${words}`,
    en: (words: string) => `Recovery phrase (write it down before continuing):\n${words}`,
  },
  recoveryPrompt: {
    pl: "Wpisz ponownie całą frazę odzyskiwania: ",
    en: "Re-enter the complete recovery phrase: ",
  },
  recoveryMismatch: {
    pl: "Fraza odzyskiwania nie zgadza się. Profil nie został utworzony.",
    en: "Recovery phrase confirmation did not match. No profile was created.",
  },
  creationOperation: {
    pl: (id: string) =>
      `Operacja tworzenia: ${id}. Jeśli odpowiedź zaginie, sprawdź: cashu profiles inspect ${id}.`,
    en: (id: string) =>
      `Creation operation: ${id}. If the result is lost, inspect with: cashu profiles inspect ${id}.`,
  },
  creationUnknown: {
    pl: (id: string) =>
      `Wynik tworzenia jest nieznany. Sprawdź: cashu profiles inspect ${id}. Nie rozpoczynaj nowej próby.`,
    en: (id: string) =>
      `Creation outcome unknown. Check: cashu profiles inspect ${id}. Do not start a new creation.`,
  },
  creationReady: {
    pl: (slug: string) => `Utworzono profil ${slug}. Połącz się ponownie, aby go użyć.`,
    en: (slug: string) => `Created profile ${slug}. Reconnect to use it.`,
  },
  creationRefusedInspect: {
    pl: (code: string, id: string) =>
      `Odmowa utworzenia profilu: ${code}. Sprawdź: cashu profiles inspect ${id}.`,
    en: (code: string, id: string) =>
      `Profile creation refused: ${code}. Check: cashu profiles inspect ${id}.`,
  },
  noProfiles: {
    pl: "Nie ma jeszcze profili. Dodaj profil: cashu profiles add NAME",
    en: "No profiles yet. Add one: cashu profiles add NAME",
  },
  profilesTitle: { pl: "Profile", en: "Profiles" },
  profileHeaders: {
    pl: ["identyfikator", "nazwa", "waluta", "prywatność agenta", "moduły"],
    en: ["slug", "name", "currency", "agent privacy", "modules"],
  },
  profileRender: {
    pl: "Szerokość terminala lub tekst profilu uniemożliwia bezpieczne wyświetlenie.",
    en: "Terminal width or profile text cannot be rendered safely.",
  },
  statsUsage: { pl: "Użycie: cashu stats [--months N]", en: "Usage: cashu stats [--months N]" },
  statsProfile: {
    pl: "Wybierz otwarty natywny profil przez --profile lub CASHU_PROFILE.",
    en: "Select an open native profile with --profile or CASHU_PROFILE.",
  },
  netWorthTitle: { pl: "Wartość netto", en: "Net worth" },
  total: {
    pl: (currency: string) => `SUMA ${currency}`,
    en: (currency: string) => `TOTAL ${currency}`,
  },
  netWorthHeaders: {
    pl: ["konto", "typ", "waluta", "stan na", "saldo"],
    en: ["account", "type", "currency", "as of", "balance"],
  },
  cashflowTitle: {
    pl: (currency: string) => `Miesięczne przepływy ${currency} (bez przelewów własnych)`,
    en: (currency: string) => `Monthly cashflow ${currency} (internal transfers excluded)`,
  },
  cashflowHeaders: {
    pl: ["miesiąc", "wpływy", "wydatki", "netto"],
    en: ["month", "income", "expense", "net"],
  },
  recurringTitle: {
    pl: "Powtarzające się płatności (prawdopodobne subskrypcje)",
    en: "Recurring payment candidates (likely subscriptions)",
  },
  recurringHeaders: {
    pl: ["odbiorca", "kwota", "liczba", "~co", "ostatnio"],
    en: ["payee", "amount", "count", "~every", "last"],
  },
  spendingTitle: {
    pl: (month: string, currency: string) => `Wydatki według kategorii ${month} (${currency})`,
    en: (month: string, currency: string) => `Spending by category ${month} (${currency})`,
  },
  spendingHeaders: { pl: ["kategoria", "kwota"], en: ["category", "amount"] },
} satisfies Record<string, TranslationVariants<unknown>>;
