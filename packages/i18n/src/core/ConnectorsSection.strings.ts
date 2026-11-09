// Texts of Settings > Konektory (frontend/src/core/ConnectorsSection.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../index.js";

export const S = catalog({
  title: { pl: "Konektory", en: "Connectors" },
  count: {
    pl: (n: number) => plCount(n, "konektor", "konektory", "konektorów"),
    en: (n: number) => enCount(n, "connector", "connectors"),
  },
  toApprove: { pl: (n: number) => `${n} do zatwierdzenia`, en: (n: number) => `${n} to approve` },
  emptyTitle: { pl: "Brak konektorów", en: "No connectors" },
  emptyBefore: {
    pl: "Importer innego banku albo brokera pisze Claude Code (skill ",
    en: "Claude Code writes an importer for another bank or broker (the ",
  },
  emptyAfter: {
    pl: " w workspace agenta) i zgłasza go tutaj do zatwierdzenia.",
    en: " skill in the agent workspace) and submits it here for approval.",
  },
  review: { pl: "Przejrzyj i zatwierdź", en: "Review and approve" },
  checkChanges: { pl: "Sprawdź zmiany", en: "Check changes" },
  foot: {
    pl: "Konektor działa dopiero po zatwierdzeniu, w piaskownicy, z limitem czasu; każda zmiana plików wymaga ponownego zatwierdzenia.",
    en: "A connector runs only once approved, in a sandbox, with a time limit; any change to its files needs approval again.",
  },
});
