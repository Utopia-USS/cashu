// Texts of the profile wizard (src/core/Wizard.tsx); the privacy question is shared with Settings. See src/i18n.ts.
import { catalog } from "../i18n.ts";
import type { Privacy } from "./api";

type PrivacyOption = { value: Privacy; title: string; desc: string; example: string };

/** The MCP privacy question (asked as an open question: neither answer is preselected). */
export const PRIVACY = catalog({
  question: { pl: "Czy agent AI może widzieć kwoty?", en: "Can the AI agent see amounts?" },
  common: {
    pl: "W obu wariantach bez numerów kont, IBAN-ów i danych osobowych.",
    en: "Either way without account numbers, IBANs or personal data.",
  },
  options: {
    pl: [
      {
        value: "strict", title: "Ścisły",
        desc: "Udziały procentowe, kategorie, daty, nazwy instrumentów.",
        example: "Przykład: zamiast „CD Projekt: 12 400 zł\" agent dostaje „CD Projekt: 6,7 % portfela\".",
      },
      {
        value: "amounts", title: "Z kwotami",
        desc: "To samo plus kwoty w walucie konta.",
        example: "Przykład: pytanie „ile wydałam na jedzenie we wrześniu\".",
      },
    ] as PrivacyOption[],
    en: [
      {
        value: "strict", title: "Strict",
        desc: "Percentage shares, categories, dates, instrument names.",
        example: "Example: instead of \"CD Projekt: PLN 12,400\" the agent gets \"CD Projekt: 6.7% of the portfolio\".",
      },
      {
        value: "amounts", title: "With amounts",
        desc: "The same plus amounts in the account currency.",
        example: "Example: the question \"how much did I spend on food in September\".",
      },
    ],
  },
});

export const S = catalog({
  nameRequired: { pl: "Podaj nazwę profilu.", en: "Enter a profile name." },
  nameTaken: { pl: "Profil o tej nazwie już istnieje.", en: "A profile with this name already exists." },
  welcome: { pl: "Witaj w cashU", en: "Welcome to cashU" },
  newProfile: { pl: "Nowy profil", en: "New profile" },
  newProfileNamed: { pl: (name: string) => `Nowy profil: ${name}`, en: (name: string) => `New profile: ${name}` },
  leadLocal: { pl: "Wszystko działa lokalnie na tym komputerze.", en: "Everything runs locally on this computer." },
  leadLater: { pl: "Do zmiany później w Ustawieniach.", en: "You can change this later in Settings." },
  leadMcp: {
    pl: "Dotyczy tylko narzędzi MCP (Claude Code, Claude Desktop). Analizy w aplikacji nie wychodzą z komputera.",
    en: "Applies only to MCP tools (Claude Code, Claude Desktop). Analyses in the app never leave the computer.",
  },
  closeEsc: { pl: "Zamknij (Esc)", en: "Close (Esc)" },
  stepProfile: { pl: "Profil", en: "Profile" },
  stepModules: { pl: "Moduły", en: "Modules" },
  stepPrivacy: { pl: "Prywatność", en: "Privacy" },
  skip: { pl: "Pomiń", en: "Skip" },
  legacyData: { pl: "Dane z poprzedniej wersji: ", en: "Data from the previous version: " },
  legacyDataAfter: { pl: ". Zamknij aplikację i uruchom:", en: ". Quit the app and run:" },
  profileName: { pl: "Nazwa profilu", en: "Profile name" },
  baseCurrencyTitle: {
    pl: "Waluta nagłówka wartości netto; inne waluty osobno, bez przeliczania.",
    en: "The currency of the net worth headline; other currencies shown separately, not converted.",
  },
  baseCurrency: { pl: "Waluta bazowa", en: "Base currency" },
  soon: { pl: "wkrótce", en: "coming soon" },
  requires: { pl: (deps: string) => `Wymaga: ${deps}.`, en: (deps: string) => `Requires: ${deps}.` },
  createWorkspace: { pl: "Utwórz workspace agenta", en: "Create the agent workspace" },
  workspaceTitle: {
    pl: "CLAUDE.md z kontekstem profilu, tylko serwer MCP tego profilu, skille włączonych modułów, blokada odczytu katalogu danych. Twoje pliki zostają przy aktualizacjach.",
    en: "CLAUDE.md with the profile's context, only this profile's MCP server, skills of the enabled modules, no read access to the data folder. Your own files stay on updates.",
  },
  workspaceHeading: { pl: "Workspace agenta (Claude Code)", en: "Agent workspace (Claude Code)" },
  workspaceDesc: {
    pl: "Folder dla Claude Code: CLAUDE.md, serwer MCP profilu, skille modułów. Dane tylko przez MCP.",
    en: "A folder for Claude Code: CLAUDE.md, the profile's MCP server, module skills. Data only through MCP.",
  },
  workspaceFolder: { pl: "Folder workspace", en: "Workspace folder" },
  workspacePlaceholder: { pl: "~/Documents/cashU/<profil>", en: "~/Documents/cashU/<profile>" },
  workspaceLater: { pl: "Do utworzenia później: Ustawienia › Agent AI.", en: "You can create it later: Settings › AI agent." },
  summary: { pl: "Podsumowanie", en: "Summary" },
  profile: { pl: "Profil", en: "Profile" },
  modules: { pl: "Moduły", en: "Modules" },
  noModules: { pl: "wartość netto i gotówka", en: "net worth and cash" },
  agent: { pl: "Agent AI", en: "AI agent" },
  strictLevel: { pl: "poziom ścisły · ", en: "strict level · " },
  strictLevelHint: { pl: "udziały procentowe, nie kwoty", en: "percentage shares, not amounts" },
  amountsLevel: { pl: "poziom z kwotami · ", en: "level with amounts · " },
  amountsLevelHint: { pl: "kwoty bez numerów kont", en: "amounts without account numbers" },
  toChoose: { pl: "do wyboru", en: "not chosen yet" },
  data: { pl: "Dane", en: "Data" },
  workspace: { pl: "Workspace agenta", en: "Agent workspace" },
  defaultFolder: { pl: "folder domyślny", en: "default folder" },
  skipped: { pl: "pominięty", en: "skipped" },
  createFailed: { pl: (err: string) => `Nie udało się utworzyć profilu: ${err}`, en: (err: string) => `Could not create the profile: ${err}` },
  workspaceFailed: { pl: (err: string) => `Profil utworzony, workspace nie: ${err}`, en: (err: string) => `Profile created, workspace not: ${err}` },
  back: { pl: "← Wstecz", en: "← Back" },
  stepOf: { pl: (n: number) => `Krok ${n} z 3`, en: (n: number) => `Step ${n} of 3` },
  picked: { pl: (modules: string) => ` · wybrano ${modules}`, en: (modules: string) => ` · ${modules} selected` },
  noModulesHint: { pl: "Bez modułów: tylko wartość netto i gotówka.", en: "No modules: only net worth and cash." },
  choosePrivacy: { pl: "Wybierz, czy agent widzi kwoty.", en: "Choose whether the agent sees amounts." },
  next: { pl: "Dalej →", en: "Next →" },
  creatingWorkspace: { pl: "Tworzę workspace…", en: "Creating the workspace…" },
  creatingProfile: { pl: "Tworzę profil…", en: "Creating the profile…" },
  createProfile: { pl: "Utwórz profil", en: "Create profile" },
});
