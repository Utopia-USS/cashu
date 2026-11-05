import { catalog } from "@cashu/i18n";

export const S = catalog({
  unknown: { pl: "Nieznany moduł.", en: "Unknown module." },
  disabled: {
    pl: "Włącz ten moduł w ustawieniach, aby zacząć.",
    en: "Enable this module in Settings to begin.",
  },
  copyFailed: { pl: "Nie udało się skopiować polecenia.", en: "Could not copy the command." },
  agentUnavailable: {
    pl: "Polecenia agenta są niedostępne dla tego profilu.",
    en: "Agent commands are unavailable for this profile.",
  },
});
