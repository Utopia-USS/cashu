// Texts of the connector drawer (src/core/ConnectorDrawer.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../i18n.ts";

type ChangeTone = "warn" | "info" | "neg";

export const CHANGE_TAG = catalog({
  modified: { pl: ["zmieniony", "warn"] as [string, ChangeTone], en: ["changed", "warn"] },
  added: { pl: ["dodany", "info"] as [string, ChangeTone], en: ["added", "info"] },
  removed: { pl: ["usunięty", "neg"] as [string, ChangeTone], en: ["removed", "neg"] },
});

export const S = catalog({
  approved: { pl: (name: string) => `Zatwierdzono ${name}`, en: (name: string) => `Approved ${name}` },
  changedWhileOpen: {
    pl: "Konektor zmienił się, odkąd go otworzyłeś: sprawdź pliki jeszcze raz.",
    en: "The connector changed since you opened it: check the files again.",
  },
  cannotApprove: { pl: (err: string) => `Nie można zatwierdzić: ${err}`, en: (err: string) => `Cannot approve: ${err}` },
  disabled: { pl: (name: string) => `Wyłączono ${name}`, en: (name: string) => `Turned off ${name}` },
  deleted: { pl: (name: string) => `Usunięto ${name}`, en: (name: string) => `Deleted ${name}` },
  deletedKept: { pl: (name: string, kept: string) => `Usunięto ${name} · ${kept}`, en: (name: string, kept: string) => `Deleted ${name} · ${kept}` },
  deleteQ: { pl: "Usunąć ", en: "Delete " },
  deleteBindings: {
    pl: (n: number) => ` Usunie też ${plCount(n, "powiązanie", "powiązania", "powiązań")} i ich sekrety.`,
    en: (n: number) => ` This also deletes ${enCount(n, "binding", "bindings")} and their secrets.`,
  },
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
  filesChanged: { pl: (summary: string) => `Pliki zmieniły się od zatwierdzenia${summary ? ` (${summary})` : ""}.`, en: (summary: string) => `The files changed since approval${summary ? ` (${summary})` : ""}.` },
  reviewBeforeEnable: { pl: "Przejrzyj zmiany przed włączeniem.", en: "Review the changes before turning it on." },
  wontRun: { pl: "Konektor nie uruchomi się do ponownego zatwierdzenia.", en: "The connector will not run until approved again." },
  interpreterWas: { pl: " Interpreter: było ", en: " Interpreter: was " },
  interpreterIs: { pl: ", jest ", en: ", now " },
  missing: { pl: "Katalog konektora zniknął z dysku. Zostaje tylko usunięcie.", en: "The connector's folder is gone from the disk. Only deleting is left." },
  invalid: { pl: "Konektor nie przechodzi walidacji:", en: "The connector fails validation:" },
  andMore: { pl: (n: number) => `… i ${n} więcej`, en: (n: number) => `… and ${n} more` },
  disabledNote: { pl: "Wyłączony: nie uruchamia się; powiązania i sekrety zostały.", en: "Off: it does not run; the bindings and secrets stay." },
  byAgent: {
    pl: "Zgłoszony przez agenta. Przejrzyj polecenie, hosty i pliki poniżej; agent nie może go zatwierdzić ani uruchomić.",
    en: "Submitted by the agent. Review the command, hosts and files below; the agent cannot approve or run it.",
  },

  // Approves
  whatYouApprove: { pl: "Co zatwierdzasz", en: "What you approve" },
  command: { pl: "Polecenie", en: "Command" },
  localExec: { pl: "plik wykonywalny z katalogu konektora (objęty sumą kontrolną)", en: "an executable from the connector's folder (covered by the checksum)" },
  interpreter: { pl: "interpreter ", en: "interpreter " },
  timeout: { pl: "Limit czasu", en: "Time limit" },
  fileDetect: { pl: "rozpoznawanie pliku 10 s", en: "file detection 10 s" },
  network: { pl: "Sieć", en: "Network" },
  hostsOnly: { pl: "tylko te hosty, port 443, przez proxy aplikacji", en: "only these hosts, port 443, through the app's proxy" },
  none: { pl: "brak", en: "none" },
  noNetwork: { pl: "piaskownica bez dostępu do sieci", en: "sandbox without network access" },
  secrets: { pl: "Sekrety", en: "Secrets" },
  secretsHint: { pl: "wpisujesz w powiązaniu; pęk kluczy; nigdy w logach ani u agenta", en: "you enter them in a binding; keychain; never in logs or with the agent" },
  params: { pl: "Parametry", en: "Parameters" },
  required: { pl: "* wymagany", en: "* required" },
  extensions: { pl: "Rozszerzenia", en: "Extensions" },
  history: { pl: "Historia", en: "History" },
  firstFetch: { pl: (days: number) => `pierwsze pobranie: ${days} dni wstecz`, en: (days: number) => `first fetch: ${days} days back` },
  checksum: { pl: "Suma kontrolna", en: "Checksum" },
  copy: { pl: "kopiuj", en: "copy" },
  copied: { pl: "Skopiowano", en: "Copied" },
  approvedSum: { pl: "zatwierdzona ", en: "approved " },
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
  installed: { pl: "Zainstalowany", en: "Installed" },
  approvedAt: { pl: "Zatwierdzony", en: "Approved" },

  // Files
  files: { pl: "Pliki", en: "Files" },
  fileCount: { pl: (n: number) => plCount(n, "plik", "pliki", "plików"), en: (n: number) => enCount(n, "file", "files") },
  file: { pl: "Plik", en: "File" },
  size: { pl: "Rozmiar", en: "Size" },
  noPreviewTitle: { pl: "plik binarny albo za duży do podglądu", en: "binary file or too large to preview" },
  execTitle: { pl: "plik wykonywalny", en: "executable file" },

  // CodeViewer
  lines: { pl: (n: number) => plCount(n, "linia", "linie", "linii"), en: (n: number) => enCount(n, "line", "lines") },
  wholeFile: { pl: "cały plik", en: "whole file" },
  changes: { pl: "zmiany", en: "changes" },
  close: { pl: "zamknij", en: "close" },
  binary: { pl: "Plik binarny: bez podglądu.", en: "Binary file: no preview." },
  tooLarge: { pl: "Plik za duży do podglądu (limit 200 KiB).", en: "File too large to preview (limit 200 KiB)." },
  noDiff: { pl: "Porównanie z zatwierdzoną wersją jest niedostępne.", en: "The comparison with the approved version is unavailable." },
  notFound: { pl: "Nie znaleziono pliku.", en: "File not found." },
  changesIn: { pl: (path: string) => `Zmiany w ${path}`, en: (path: string) => `Changes in ${path}` },
  noContentDiff: { pl: "Bez różnic w treści.", en: "No differences in content." },

  // Runs
  lastN: { pl: (n: number) => `ostatnie ${n}`, en: (n: number) => `last ${n}` },
  runs: { pl: "Przebiegi", en: "Runs" },
  colWhen: { pl: "Kiedy", en: "When" },
  colCommand: { pl: "Polecenie", en: "Command" },
  colResult: { pl: "Wynik", en: "Result" },
  colRecords: { pl: "Rekordy", en: "Records" },
  colDenied: { pl: "Hosty odrzucone", en: "Hosts denied" },
  profileTitle: { pl: (p: string) => `profil ${p}`, en: (p: string) => `profile ${p}` },
  neverRun: { pl: "Jeszcze nie uruchomiony.", en: "Not run yet." },
  runsFoot: { pl: "Ostatnie 20 z 500 zapisanych · stderr tylko tutaj, nigdy u agenta.", en: "Last 20 of 500 stored · stderr only here, never with the agent." },
});
