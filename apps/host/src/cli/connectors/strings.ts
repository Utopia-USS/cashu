export const M = {
  usage: {
    pl: "Użycie: cashu connectors add|list|show|test|disable|remove|catalog list|catalog add",
    en: "Usage: cashu connectors add|list|show|test|disable|remove|catalog list|catalog add",
  },
  unavailable: {
    pl: "Ta operacja wymaga zatwierdzenia w aplikacji lub dodatkowej bezpiecznej funkcji hosta.",
    en: "This operation needs approval in the app or an additional checked host capability.",
  },
  invalid: { pl: "Nieprawidłowy konektor lub ścieżka.", en: "Invalid connector or path." },
  pending: {
    pl: "Konektor czeka na zatwierdzenie w aplikacji.",
    en: "Connector submitted for review in the app.",
  },
  exists: {
    pl: "Konektor jest już zainstalowany. Użyj --replace.",
    en: "Connector is already installed. Use --replace.",
  },
  disabled: { pl: "Konektor wyłączono.", en: "Connector disabled." },
  removed: { pl: "Konektor usunięto.", en: "Connector removed." },
  confirmRemove: {
    pl: "Usunąć konektor, jego powiązania, sekrety i historię? [t/N] ",
    en: "Remove this connector, its bindings, secrets and history? [y/N] ",
  },
} as const;
