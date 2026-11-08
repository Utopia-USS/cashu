// Texts of the connector drawer (frontend/src/core/ConnectorDrawer.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  yesDelete: { pl: "Tak, usuń", en: "Yes, delete" },
  turnOff: { pl: "Wyłącz", en: "Turn off" },
  approveAgain: { pl: "Zatwierdź ponownie", en: "Approve again" },
  approveEnable: { pl: "Zatwierdź i włącz", en: "Approve and turn on" },
  approve: { pl: "Zatwierdź", en: "Approve" },
  connector: { pl: "Konektor", en: "Connector" },
  foot: {
    pl: "Wyłączenie zatrzymuje przebiegi, powiązania zostają. Usunięcie kasuje katalog, powiązania i sekrety.",
    en: "Turning it off stops the runs, the bindings stay. Deleting removes the folder, the bindings and the secrets.",
  },

  // Notices
  filesChanged: {
    pl: (summary: string) =>
      `Pliki zmieniły się od zatwierdzenia${summary ? ` (${summary})` : ""}.`,
    en: (summary: string) => `The files changed since approval${summary ? ` (${summary})` : ""}.`,
  },
  wontRun: {
    pl: "Konektor nie uruchomi się do ponownego zatwierdzenia.",
    en: "The connector will not run until approved again.",
  },
  disabledNote: {
    pl: "Wyłączony: nie uruchamia się; powiązania i sekrety zostały.",
    en: "Off: it does not run; the bindings and secrets stay.",
  },

  // Approves
  whatYouApprove: { pl: "Co zatwierdzasz", en: "What you approve" },
  command: { pl: "Polecenie", en: "Command" },
  localExec: {
    pl: "plik wykonywalny z katalogu konektora (objęty sumą kontrolną)",
    en: "an executable from the connector's folder (covered by the checksum)",
  },
  interpreter: { pl: "interpreter ", en: "interpreter " },
  timeout: { pl: "Limit czasu", en: "Time limit" },
  fileDetect: { pl: "rozpoznawanie pliku 10 s", en: "file detection 10 s" },
  network: { pl: "Sieć", en: "Network" },
  hostsOnly: {
    pl: "tylko te hosty, port 443, przez proxy aplikacji",
    en: "only these hosts, port 443, through the app's proxy",
  },
  none: { pl: "brak", en: "none" },
  noNetwork: { pl: "piaskownica bez dostępu do sieci", en: "sandbox without network access" },
  secrets: { pl: "Sekrety", en: "Secrets" },
  secretsHint: {
    pl: "wpisujesz w powiązaniu; pęk kluczy; nigdy w logach ani u agenta",
    en: "you enter them in a binding; keychain; never in logs or with the agent",
  },
  params: { pl: "Parametry", en: "Parameters" },
  required: { pl: "* wymagany", en: "* required" },
  extensions: { pl: "Rozszerzenia", en: "Extensions" },
  history: { pl: "Historia", en: "History" },
  firstFetch: {
    pl: (days: number) => `pierwsze pobranie: ${days} dni wstecz`,
    en: (days: number) => `first fetch: ${days} days back`,
  },
  checksum: { pl: "Suma kontrolna", en: "Checksum" },
  copy: { pl: "kopiuj", en: "copy" },
  diskWrite: { pl: "Zapis na dysku", en: "Disk writes" },
  tmpOnly: { pl: "tylko katalog tymczasowy przebiegu", en: "only the run's temporary folder" },
  sandbox: {
    pl: "Piaskownica: odczyt systemu i własnego katalogu, zapis tylko do katalogu tymczasowego; proces zabijany po limicie czasu.",
    en: "Sandbox: reads the system and its own folder, writes only to the temporary folder; the process is killed after the time limit.",
  },

  // Details
  details: { pl: "Szczegóły", en: "Details" },
  id: { pl: "Identyfikator", en: "Identifier" },
  version: { pl: "Wersja", en: "Version" },
  author: { pl: "Autor", en: "Author" },
  description: { pl: "Opis", en: "Description" },
  module: { pl: "Moduł", en: "Module" },
  kind: { pl: "Rodzaj", en: "Kind" },
  approvedAt: { pl: "Zatwierdzony", en: "Approved" },

  // Runs
  lastN: { pl: (n: number) => `ostatnie ${n}`, en: (n: number) => `last ${n}` },
  runs: { pl: "Przebiegi", en: "Runs" },
  colWhen: { pl: "Kiedy", en: "When" },
  colCommand: { pl: "Polecenie", en: "Command" },
  colResult: { pl: "Wynik", en: "Result" },
  colRecords: { pl: "Rekordy", en: "Records" },
  colDenied: { pl: "Hosty odrzucone", en: "Hosts denied" },
  neverRun: { pl: "Jeszcze nie uruchomiony.", en: "Not run yet." },
  runsFoot: {
    pl: "Ostatnie 20 z 500 zapisanych · stderr tylko tutaj, nigdy u agenta.",
    en: "Last 20 of 500 stored · stderr only here, never with the agent.",
  },
});
