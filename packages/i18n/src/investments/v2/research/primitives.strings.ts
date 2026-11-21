// Texts of the research primitives (frontend/src/modules/investments/v2/research/primitives.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../../../index.js";

export const S = catalog({
  thesisState: { pl: (h: string) => `teza: ${h}`, en: (h: string) => `thesis: ${h}` },
  researchPredates: {
    pl: (base: string) => `${base} · research sprzed zmiany tezy`,
    en: (base: string) => `${base} · research from before the thesis change`,
  },
  predatesThesis: { pl: "sprzed zmiany tezy", en: "before thesis change" },
  noWeekData: { pl: "brak", en: "none" },
  sentimentAria: {
    pl: (desc: string) => `Sentyment 8 tygodni, od najstarszego: ${desc}`,
    en: (desc: string) => `Sentiment over 8 weeks, oldest first: ${desc}`,
  },
  dismissedOn: { pl: (d: string) => `odrzucona ${d}`, en: (d: string) => `dismissed ${d}` },
  restore: { pl: "przywróć", en: "restore" },
  sourcesN: { pl: (n: number) => `źródła (${n})`, en: (n: number) => `sources (${n})` },
  dismiss: { pl: "odrzuć", en: "dismiss" },
  srcLine: {
    pl: (n: number, d: string) => `${plCount(n, "źródło", "źródła", "źródeł")} · ${d}`,
    en: (n: number, d: string) => `${enCount(n, "source", "sources")} · ${d}`,
  },
  candDismissedOn: { pl: (d: string) => `odrzucony ${d}`, en: (d: string) => `dismissed ${d}` },
  returnsEarliest: {
    pl: (d: string) => ` · wraca najwcześniej ${d}`,
    en: (d: string) => ` · returns ${d} at the earliest`,
  },
  met: { pl: "spełnione", en: "met" },
  notMet: { pl: "niespełnione", en: "not met" },
  addedByAgent: { pl: "dodany przez agenta", en: "added by the agent" },
  watchedSince: {
    pl: (d: string) => `obserwowany od ${d}`,
    en: (d: string) => `watched since ${d}`,
  },
  watchTitle: {
    pl: "Dodaje do Obserwowanych z wersją roboczą tezy",
    en: "Adds it to the Watchlist with a draft thesis",
  },
  watch: { pl: "Obserwuj", en: "Watch" },
  dismissTitle: { pl: "Wraca po 90 dniach", en: "Comes back after 90 days" },
  dismissBtn: { pl: "Odrzuć", en: "Dismiss" },
  copiedPaste: { pl: "Skopiowano · wklej w Claude Code", en: "Copied · paste it into Claude Code" },
  schedule: {
    pl: ": sobota 07:00, folder ",
    en: ": Saturday 07:00, folder ",
  },
  prompt: { pl: ", polecenie ", en: ", prompt " },
  copyRoutine: { pl: "Kopiuj polecenie rutyny", en: "Copy the routine prompt" },
  copiedPasteApp: {
    pl: "Skopiowano · wklej w aplikacji Claude",
    en: "Copied · paste it into the Claude app",
  },
  localRoutineTitle: {
    pl: "Rutyna lokalna: tylko ona widzi serwer MCP na tym Macu.",
    en: "A local routine: only it can reach the MCP server on this Mac.",
  },
  copyFolder: { pl: "Kopiuj folder", en: "Copy the folder" },
  copied: { pl: "Skopiowano", en: "Copied" },
  settingsLink: { pl: "Szczegóły: Ustawienia › Agent AI", en: "Details: Settings › AI agent" },
});
