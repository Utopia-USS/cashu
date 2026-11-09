import type { TranslationVariants } from "@cashu/i18n";

/** Native loans and assets CLI copy. Command names and status keys stay machine stable. */
export const N = {
  commandUnknown: {
    pl: (command: string, key: string) =>
      `Wynik polecenia jest nieznany. Sprawdź: cashu command-status ${command} ${key}. Nie rozpoczynaj nowej próby przed wyjaśnieniem wyniku.`,
    en: (command: string, key: string) =>
      `Command outcome unknown. Check: cashu command-status ${command} ${key}. Do not issue a new attempt until reconciled.`,
  },
  commandFailure: {
    pl: (kind: string, reason: string, key: string) =>
      `Polecenie ${kind}: ${reason}. Klucz idempotencji: ${key}.`,
    en: (kind: string, reason: string, key: string) =>
      `Command ${kind}: ${reason}. Idempotency key: ${key}.`,
  },
  projectionUnavailable: {
    pl: (command: string, key: string) =>
      `Polecenie wykonane, ale bieżący widok jest niedostępny. Sprawdź: cashu command-status ${command} ${key}.`,
    en: (command: string, key: string) =>
      `Command completed, but its current view is unavailable. Check: cashu command-status ${command} ${key}.`,
  },
  selectProfile: {
    pl: "Wybierz profil przez --profile lub CASHU_PROFILE.",
    en: "Select a profile with --profile or CASHU_PROFILE.",
  },
  missingProfile: {
    pl: "Wybrany profil nie jest otwartym natywnym sejfem.",
    en: "Selected profile is not an open native vault.",
  },
  assetsUsage: {
    pl: "Użycie: cashu assets add-position|set-vehicle ...",
    en: "Usage: cashu assets add-position|set-vehicle ...",
  },
  positionUsage: {
    pl: "Użycie: cashu add-position NAZWA --type TYP --value KWOTA [--currency KOD] [--note TEKST]",
    en: "Usage: cashu add-position NAME --type TYPE --value AMOUNT [--currency CODE] [--note TEXT]",
  },
  invalidPosition: {
    pl: "Nieprawidłowa nazwa, typ, wartość lub waluta składnika majątku.",
    en: "Invalid position name, type, value, or currency.",
  },
  profileUnavailable: {
    pl: "Wybrany profil jest niedostępny.",
    en: "Selected profile is unavailable.",
  },
  positionSavedUncertain: {
    pl: (command: string, key: string) =>
      `Zapisano składnik majątku; sprawdź: cashu command-status ${command} ${key}.`,
    en: (command: string, key: string) =>
      `Position saved; inspect: cashu command-status ${command} ${key}.`,
  },
  positionSaved: {
    pl: (gid: string, amount: string) => `Składnik majątku ${gid}: ${amount}.`,
    en: (gid: string, amount: string) => `Position ${gid}: ${amount}.`,
  },
  loanAddUsage: {
    pl: "Użycie: cashu loans add [NAZWA] --principal KWOTA --rate PROCENT [--account GID] [--months N|--years N]",
    en: "Usage: cashu loans add [NAME] --principal AMOUNT --rate PERCENT [--account GID] [--months N|--years N]",
  },
  loanSetUsage: {
    pl: "Użycie: cashu set-loan ACCOUNT_GID KWOTA OPROCENTOWANIE [--months N|--years N]",
    en: "Usage: cashu set-loan ACCOUNT_GID PRINCIPAL RATE [--months N|--years N]",
  },
  loanChoice: {
    pl: "Podaj NAZWĘ albo --account GID i typ mortgage lub loan.",
    en: "Specify either NAME or --account GID, with type mortgage or loan.",
  },
  loanAccount: {
    pl: "--account musi wskazywać dokładnie jedno widoczne konto kredytowe w wybranym profilu.",
    en: "--account must identify exactly one visible mortgage or loan account in the selected profile.",
  },
  loanSavedUncertain: {
    pl: (command: string, key: string) =>
      `Zapisano kredyt; sprawdź: cashu command-status ${command} ${key}.`,
    en: (command: string, key: string) =>
      `Loan saved; inspect: cashu command-status ${command} ${key}.`,
  },
  loanSaved: {
    pl: (loan: string, account: string, amount: string, rate: string) =>
      `Kredyt ${loan} (konto ${account}): ${amount}, oprocentowanie ${rate}%.`,
    en: (loan: string, account: string, amount: string, rate: string) =>
      `Loan ${loan} (account ${account}): ${amount} at ${rate}%.`,
  },
  loanTerms: {
    pl: (account: string, amount: string, rate: string, months: number, start: string) =>
      `Konto kredytowe ${account}: ${amount}, ${rate}%, ${months} mies., pierwsza rata ${start}.`,
    en: (account: string, amount: string, rate: string, months: number, start: string) =>
      `Loan account ${account}: ${amount} at ${rate}%, ${months} months, first installment ${start}.`,
  },
  loanPaymentUsage: {
    pl: "Użycie: cashu loans set-payment LOAN_GID [--iban IBAN] [--text FRAZA]",
    en: "Usage: cashu loans set-payment LOAN_GID [--iban IBAN] [--text PHRASE]",
  },
  loanBalanceUsage: {
    pl: "Użycie: cashu loans set-balance LOAN_GID KWOTA [--date YYYY-MM-DD]",
    en: "Usage: cashu loans set-balance LOAN_GID AMOUNT [--date YYYY-MM-DD]",
  },
  loanMissing: {
    pl: "GID kredytu nie należy do wybranego profilu.",
    en: "Loan GID is not in the selected profile.",
  },
  loanPaymentSaved: {
    pl: (gid: string) =>
      `Zapisano dopasowanie rat kredytu ${gid}. Uruchom cashu categorize dla istniejących transakcji.`,
    en: (gid: string) =>
      `Loan ${gid}: installment matching saved. Run cashu categorize for existing transactions.`,
  },
  loanBalanceSaved: {
    pl: (gid: string, amount: string) => `Zapisano saldo kredytu ${gid}: ${amount}.`,
    en: (gid: string, amount: string) => `Recorded outstanding loan ${gid}: ${amount}.`,
  },
  loanListUsage: { pl: "Użycie: cashu loans list", en: "Usage: cashu loans list" },
  noLoans: {
    pl: "Brak kredytów. Dodaj: cashu loans add NAZWA --principal ... --rate ...",
    en: "No loans. Add one: cashu loans add NAME --principal ... --rate ...",
  },
  loansTitle: { pl: "Kredyty", en: "Loans" },
  loanGid: {
    pl: (gid: string) => `GID kredytu ${gid}`,
    en: (gid: string) => `Loan GID ${gid}`,
  },
  loanHeaders: {
    pl: ["gid", "nazwa", "typ", "oprocentowanie", "od", "okres", "saldo", "źródło"],
    en: ["gid", "name", "type", "rate", "start", "term", "outstanding", "source"],
  },
  monthCount: {
    pl: (months: number) => `${months} mies.`,
    en: (months: number) => `${months} mo`,
  },
  balanceSource: {
    pl: (source: "recorded" | "schedule"): string =>
      source === "recorded" ? "zapisane" : "harmonogram",
    en: (source: "recorded" | "schedule"): string => source,
  },
  loanRender: {
    pl: "Ten terminal nie może bezpiecznie wyświetlić tabeli kredytów.",
    en: "This terminal cannot render the loans table safely.",
  },
  loansUsage: {
    pl: "Użycie: cashu loans list|add|set-payment|set-balance ...",
    en: "Usage: cashu loans list|add|set-payment|set-balance ...",
  },
} satisfies Record<string, TranslationVariants<unknown>>;
