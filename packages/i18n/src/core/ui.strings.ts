// Texts of the shared UI primitives (frontend/src/ui.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

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
