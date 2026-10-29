// Texts of the shared UI primitives (src/ui.tsx). See src/i18n.ts.
import { catalog } from "./i18n.ts";

export const S = catalog({
  steps: { pl: "Kroki", en: "Steps" },
  stepDone: { pl: "zrobione", en: "done" },
  stepN: { pl: (n: number) => `krok ${n}`, en: (n: number) => `step ${n}` },
  optional: { pl: "opcjonalnie", en: "optional" },
  copied: { pl: "Skopiowano", en: "Copied" },
  copy: { pl: "Kopiuj", en: "Copy" },
  notifications: { pl: "Powiadomienia", en: "Notifications" },
  noData: { pl: "Brak danych.", en: "No data." },
  closeEsc: { pl: "Zamknij (Esc)", en: "Close (Esc)" },
});
