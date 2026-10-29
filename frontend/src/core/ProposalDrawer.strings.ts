// Texts of the proposal drawer (src/core/ProposalDrawer.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../i18n.ts";

export const S = catalog({
  kindBudgetImport: { pl: "import wyciągu", en: "statement import" },
  kindImport: { pl: "import", en: "import" },
  kindStrategy: { pl: "strategia", en: "strategy" },
  kindRule: { pl: "reguła", en: "rule" },
  title: { pl: "Propozycja agenta", en: "Agent proposal" },
  reject: { pl: "Odrzuć", en: "Reject" },
  approveImport: { pl: "Zatwierdź import", en: "Approve import" },
  approveAs: { pl: (v: number) => `Zatwierdź jako v${v}`, en: (v: number) => `Approve as v${v}` },
  loadFailed: { pl: (err: string) => `Nie udało się wczytać propozycji: ${err}`, en: (err: string) => `Could not load the proposal: ${err}` },
  changeProposal: { pl: "Propozycja zmiany", en: "Change proposal" },
  submitted: { pl: (date: string) => `zgłoszona ${date}`, en: (date: string) => `submitted ${date}` },
  approved: { pl: "zatwierdzona", en: "approved" },
  rejected: { pl: "odrzucona", en: "rejected" },
  failed: { pl: "nie udało się zastosować", en: "could not be applied" },
  unsupported: {
    pl: "Tego skryptu konwertera nie da się zatwierdzić: aplikacja uruchamia tylko konektory zatwierdzone w Ustawieniach › Konektory. Poproś agenta o konektor albo gotowy plik w formacie cashU.",
    en: "This converter script cannot be approved: the app runs only connectors approved in Settings › Connectors. Ask the agent for a connector or a ready file in the cashU format.",
  },
  baseChanged: { pl: "Pliki strategii zmieniły się od propozycji: poproś agenta o nową.", en: "The strategy files changed since the proposal: ask the agent for a new one." },
  agentReason: { pl: "Uzasadnienie agenta:", en: "Agent's reasoning:" },
  yamlChange: { pl: "Zmiana w strategy.yaml", en: "Change in strategy.yaml" },
  mdChange: { pl: "Zmiana w strategy.md", en: "Change in strategy.md" },
  newRule: { pl: "Nowa reguła", en: "New rule" },
  backtest: {
    pl: (range: string, fired: number, evaluated: number, episodes: number) =>
      `Test wsteczny ${range}: reguła zadziałałaby w ${fired} z ${evaluated} punktów (${plCount(episodes, "epizod", "epizody", "epizodów")})`,
    en: (range: string, fired: number, evaluated: number, episodes: number) =>
      `Backtest ${range}: the rule would have fired at ${fired} of ${evaluated} points (${enCount(episodes, "episode", "episodes")})`,
  },
  lastFired: { pl: (date: string) => `, ostatnio ${date}`, en: (date: string) => `, last ${date}` },
  noHistory: { pl: "Test wsteczny: brak historii transakcji.", en: "Backtest: no transaction history." },
  source: { pl: "Źródło", en: "Source" },
  connector: { pl: "konektor", en: "connector" },
  since: { pl: (date: string) => `od ${date}`, en: (date: string) => `since ${date}` },
  file: { pl: "Plik", en: "File" },
  account: { pl: "Konto", en: "Account" },
  preview: { pl: "Podgląd", en: "Preview" },
  newTxns: { pl: (n: number) => plCount(n, "nowa transakcja", "nowe transakcje", "nowych transakcji"), en: (n: number) => enCount(n, "new transaction", "new transactions") },
  duplicates: { pl: (n: number) => plCount(n, "duplikat", "duplikaty", "duplikatów"), en: (n: number) => enCount(n, "duplicate", "duplicates") },
  warnings: { pl: (n: number) => plCount(n, "ostrzeżenie", "ostrzeżenia", "ostrzeżeń"), en: (n: number) => enCount(n, "warning", "warnings") },
  brokerageAccount: { pl: "Rachunek", en: "Account" },
  newRows: { pl: (n: number) => plCount(n, "nowy wiersz", "nowe wiersze", "nowych wierszy"), en: (n: number) => enCount(n, "new row", "new rows") },
  mismatches: {
    pl: (n: number) => `${plCount(n, "różnica", "różnice", "różnic")} ze snapshotem`,
    en: (n: number) => `${enCount(n, "difference", "differences")} from the snapshot`,
  },
  errors: { pl: (n: number) => plCount(n, "błąd", "błędy", "błędów"), en: (n: number) => enCount(n, "error", "errors") },
  rejectChangesNothing: { pl: "Odrzucenie niczego nie zmienia.", en: "Rejecting changes nothing." },
});
