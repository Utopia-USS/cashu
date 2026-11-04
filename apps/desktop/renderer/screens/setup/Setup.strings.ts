import { catalog } from "@cashu/i18n";

export const S = catalog({
  title: { pl: (name: string) => `Konfiguracja: ${name}`, en: (name: string) => `Set up ${name}` },
  unknown: { pl: "Nieznany moduł.", en: "Unknown module." },
  disabled: {
    pl: "Włącz ten moduł w ustawieniach, aby zacząć.",
    en: "Enable this module in Settings to begin.",
  },
  ready: { pl: "Gotowe", en: "Ready" },
  partial: {
    pl: (done: number, total: number) => `${done} z ${total} kroków`,
    en: (done: number, total: number) => `${done} of ${total} steps`,
  },
  noSteps: { pl: "Ten moduł nie ma kroków konfiguracji.", en: "This module has no setup steps." },
  optional: { pl: "Opcjonalny", en: "Optional" },
  done: { pl: "Ukończono", en: "Done" },
  current: { pl: "Teraz", en: "Current" },
  later: { pl: "Później", en: "Later" },
  unavailableAction: {
    pl: "Ta czynność nie jest jeszcze dostępna tutaj.",
    en: "This action is not available here yet.",
  },
  copied: { pl: "Skopiowano polecenie.", en: "Command copied." },
  copyFailed: { pl: "Nie udało się skopiować polecenia.", en: "Could not copy the command." },
  openModule: { pl: "Otwórz moduł", en: "Open module" },
  openOverview: { pl: "Otwórz przegląd", en: "Open overview" },
  agentTitle: { pl: "Agent AI", en: "AI agent" },
  agentUnavailable: {
    pl: "Polecenia agenta są niedostępne dla tego profilu.",
    en: "Agent commands are unavailable for this profile.",
  },
  connectOnce: {
    pl: "Połącz serwer MCP raz dla tego profilu",
    en: "Connect the MCP server once for this profile",
  },
  runSkill: { pl: "Uruchom umiejętność konfiguracji", en: "Run the setup skill" },
  copy: { pl: "Kopiuj", en: "Copy" },
  translocated: {
    pl: "Aplikacja jest przeniesiona. Użyj aktualnego polecenia poniżej.",
    en: "The app was moved. Use the current command below.",
  },
  privacyStrict: {
    pl: "Agent widzi tylko dane dozwolone przez ścisłą prywatność.",
    en: "The agent sees only data allowed by strict privacy.",
  },
  privacyAmounts: {
    pl: "Agent może widzieć kwoty zgodnie z ustawieniem profilu.",
    en: "The agent may see amounts under this profile setting.",
  },
  settings: { pl: "Ustawienia agenta", en: "Agent settings" },
});
