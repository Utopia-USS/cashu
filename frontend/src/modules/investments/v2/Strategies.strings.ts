// Texts of the Strategie tab (Strategies.tsx). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

export const S = catalog({
  tab: { pl: "Strategie", en: "Strategies" },
  listLabel: { pl: "Strategie i ich pliki", en: "Strategies and their files" },
  mainTitle: { pl: "Strategia główna", en: "Main strategy" },
  executed: { pl: "wykonywana", en: "executed" },
  executedTitle: {
    pl: "Reguły z tego pliku YAML działają: aplikacja sprawdza je codziennie i tworzy sygnały.",
    en: "The rules of this YAML file run: the app checks them daily and creates signals.",
  },
  document: { pl: "dokument", en: "document" },
  documentTitle: {
    pl: "Dokument strategii: aplikacja go pokazuje, agent czyta go przy przeglądach i researchu.",
    en: "A strategy document: the app shows it, the agent reads it during reviews and research.",
  },
  noFiles: { pl: "brak plików", en: "no files" },
  preview: { pl: "Podgląd", en: "Preview" },
  source: { pl: "Źródło", en: "Source" },
  viewMode: { pl: "Widok pliku", en: "File view" },
  copyPath: { pl: "Kopiuj ścieżkę", en: "Copy path" },
  pathCopied: { pl: (name: string) => `Skopiowano ścieżkę ${name}`, en: (name: string) => `Copied the path of ${name}` },
  notExecuted: {
    pl: "Ten plik YAML nie jest jeszcze wykonywany: reguły z niego nie tworzą sygnałów. Aplikacja wykonuje tylko strategię główną.",
    en: "This YAML file is not executed yet: its rules create no signals. The app runs only the main strategy.",
  },
  issuesHere: { pl: (n: number) => (n === 1 ? "1 uwaga w tym pliku" : `${n} uwag w tym pliku`), en: (n: number) => (n === 1 ? "1 issue in this file" : `${n} issues in this file`) },
  emptyFile: { pl: "Plik jest pusty.", en: "The file is empty." },
  loadFailed: { pl: (err: string) => `Nie wczytano pliku: ${err}`, en: (err: string) => `File not loaded: ${err}` },
  listFailed: { pl: (err: string) => `Nie wczytano strategii: ${err}`, en: (err: string) => `Strategies not loaded: ${err}` },
  noneTitle: { pl: "Nie masz jeszcze strategii", en: "You have no strategy yet" },
  noneHint: {
    pl: "Strategię pisze agent z Tobą: wywiad /investments-setup. Może to być dowolny dokument (reguły, sygnały z narzędzia, grupa na Telegramie, własny styl); plik YAML jest potrzebny tylko wtedy, gdy aplikacja ma czegoś pilnować.",
    en: "Your agent writes the strategy with you: the /investments-setup interview. It can be any document (rules, signals from a tool, a Telegram group, your own style); a YAML file is needed only when the app should watch something.",
  },
  mainMissing: {
    pl: "Strategia główna nie istnieje. To ją aplikacja wykonuje (reguły i sygnały); pozostałe strategie są dokumentami.",
    en: "The main strategy does not exist. It is the one the app executes (rules and signals); the other strategies are documents.",
  },
  fromTemplate: { pl: "Utwórz z szablonu", en: "Create from a template" },
  copyCommand: { pl: "Kopiuj /investments-setup", en: "Copy /investments-setup" },
  commandCopied: { pl: "Skopiowano polecenie", en: "Command copied" },
  created: { pl: "Utworzono strategię z szablonu", en: "Strategy created from the template" },
  createFailed: { pl: (err: string) => `Nie utworzono strategii: ${err}`, en: (err: string) => `Strategy not created: ${err}` },
  folderHint: {
    pl: "Kolejne strategie agent zapisuje jako pliki .md (i opcjonalnie .yaml) w folderze strategies.",
    en: "Your agent saves further strategies as .md files (and optionally .yaml) in the strategies folder.",
  },
  copyFolder: { pl: "Kopiuj ścieżkę folderu", en: "Copy the folder path" },
  line: { pl: (n: number) => `wiersz ${n}`, en: (n: number) => `line ${n}` },
});
