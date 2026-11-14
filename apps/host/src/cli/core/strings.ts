import type { TranslationVariants } from "@cashu/i18n";

export const C = {
  selectProfile: {
    pl: "Wybierz profil opcją --profile lub zmienną CASHU_PROFILE.",
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
    pl: "Nie można bezpiecznie wyświetlić kont: za wąski terminal lub nieobsługiwany tekst konta.",
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
  languageUsage: {
    pl: "Użycie: cashu language [pl|en|system]. Bez argumentu pokazuje bieżący język aplikacji.",
    en: "Usage: cashu language [pl|en|system]. Without an argument it shows the current app language.",
  },
  languageName: {
    pl: { pl: "polski", en: "Polish" },
    en: { pl: "angielski", en: "English" },
  },
  languageCurrent: {
    pl: (name: string, system: boolean) =>
      `Język aplikacji: ${name}${system ? " (jak w systemie)" : " (ustawiony)"}.`,
    en: (name: string, system: boolean) =>
      `App language: ${name}${system ? " (follows the system)" : " (pinned)"}.`,
  },
  languageSet: {
    pl: (name: string, system: boolean) =>
      `Język aplikacji: ${name}${system ? " (jak w systemie)" : ""}. Okno aplikacji przeładuje się samo, agent dostanie ten język w następnej sesji.`,
    en: (name: string, system: boolean) =>
      `App language: ${name}${system ? " (follows the system)" : ""}. The app window reloads by itself; the agent gets this language in its next session.`,
  },
  languageRefused: {
    pl: "Nie udało się zapisać języka aplikacji.",
    en: "The app language could not be saved.",
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
      `Nie wiadomo, czy operacja ${id} się udała (${stage}). Sprawdź jej stan, zanim spróbujesz ponownie.`,
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
      `Operacja tworzenia profilu: ${id}. Jeśli wynik nie dotrze, sprawdź: cashu profiles inspect ${id}.`,
    en: (id: string) =>
      `Creation operation: ${id}. If the result is lost, inspect with: cashu profiles inspect ${id}.`,
  },
  creationUnknown: {
    pl: (id: string) =>
      `Nie wiadomo, czy profil został utworzony. Sprawdź: cashu profiles inspect ${id}. Nie twórz go ponownie.`,
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
    pl: "Nie można bezpiecznie wyświetlić profili: za wąski terminal lub nieobsługiwany tekst profilu.",
    en: "Terminal width or profile text cannot be rendered safely.",
  },
  statsUsage: { pl: "Użycie: cashu stats [--months N]", en: "Usage: cashu stats [--months N]" },
  statsProfile: {
    pl: "Wybierz otwarty profil natywny opcją --profile lub zmienną CASHU_PROFILE.",
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
    pl: (currency: string) => `Miesięczne przepływy ${currency} (bez przelewów wewnętrznych)`,
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
  skillsUsage: {
    pl: "Użycie: cashu skills path | cashu skills install [--dest KATALOG] [--force]",
    en: "Usage: cashu skills path | cashu skills install [--dest DIR] [--force]",
  },
  skillsUnreadable: {
    pl: "Nie można odczytać skilli dołączonych do tej instalacji.",
    en: "The skills shipped with this installation cannot be read.",
  },
  skillsUserHome: {
    pl: "--dest rozpoznaje tylko ~ i ~/. Katalog innego użytkownika podaj jako pełną ścieżkę.",
    en: "--dest expands only ~ and ~/. Give another user's folder as a full path.",
  },
  skillsNoHome: {
    pl: "Katalog domowy jest nieznany. Podaj --dest jako pełną ścieżkę.",
    en: "Your home folder is unknown. Give --dest as a full path.",
  },
  skillsControlText: {
    pl: "Ścieżka --dest lub nazwa skilla zawiera znaki sterujące.",
    en: "The --dest path or a skill name contains control characters.",
  },
  skillsInsideSource: {
    pl: "Katalog docelowy leży w katalogu skilli tej instalacji.",
    en: "The destination is inside this installation's skills.",
  },
  skillsNotDirectory: {
    pl: (dest: string) => `${dest} nie jest katalogiem.`,
    en: (dest: string) => `${dest} is not a folder.`,
  },
  skillsNotWritable: {
    pl: (dest: string) => `Brak uprawnień do zapisu w ${dest}. Nic nie zostało skopiowane.`,
    en: (dest: string) => `No permission to write to ${dest}. Nothing was copied.`,
  },
} satisfies Record<string, TranslationVariants<unknown>>;
