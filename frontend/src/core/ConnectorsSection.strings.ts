// Texts of Settings > Konektory (src/core/ConnectorsSection.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../i18n.ts";

export const S = catalog({
  title: { pl: "Konektory", en: "Connectors" },
  count: { pl: (n: number) => plCount(n, "konektor", "konektory", "konektorów"), en: (n: number) => enCount(n, "connector", "connectors") },
  toApprove: { pl: (n: number) => `${n} do zatwierdzenia`, en: (n: number) => `${n} to approve` },
  noSandbox: {
    pl: "Konektory działają tylko w aplikacji na macOS (brak piaskownicy).",
    en: "Connectors run only in the macOS app (no sandbox here).",
  },
  loadFailed: { pl: (err: string) => `Nie udało się pobrać konektorów: ${err}`, en: (err: string) => `Could not load the connectors: ${err}` },
  emptyTitle: { pl: "Brak konektorów", en: "No connectors" },
  emptyBefore: {
    pl: "Importer innego banku albo brokera pisze Claude Code (skill ",
    en: "Claude Code writes an importer for another bank or broker (the ",
  },
  emptyAfter: {
    pl: " w workspace agenta) i zgłasza go tutaj do zatwierdzenia.",
    en: " skill in the agent workspace) and submits it here for approval.",
  },
  howItWorks: { pl: "Jak działa konektor", en: "How a connector works" },
  filesDifferTitle: { pl: "Pliki różnią się od zatwierdzonych", en: "The files differ from the approved ones" },
  changed: { pl: "zmieniony", en: "changed" },
  byAgentTitle: { pl: "Zgłoszony przez agenta (propose_connector)", en: "Submitted by the agent (propose_connector)" },
  review: { pl: "Przejrzyj i zatwierdź", en: "Review and approve" },
  checkChanges: { pl: "Sprawdź zmiany", en: "Check changes" },
  foot: {
    pl: "Konektor działa dopiero po zatwierdzeniu, w piaskownicy, z limitem czasu; każda zmiana plików wymaga ponownego zatwierdzenia.",
    en: "A connector runs only once approved, in a sandbox, with a time limit; any change to its files needs approval again.",
  },
  imported: { pl: "Zaimportowano", en: "Imported" },
  rejected: { pl: "Odrzucono", en: "Rejected" },
});
