// Texts of the module setup page (src/core/SetupPage.tsx). See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  ready: { pl: "gotowy", en: "ready" },
  notConfigured: { pl: "nieskonfigurowany", en: "not set up" },
  strictBold: { pl: "Poziom ścisły:", en: "Strict level:" },
  strictText: { pl: " udziały, kategorie, daty; bez kwot i numerów kont.", en: " shares, categories, dates; no amounts or account numbers." },
  amountsBold: { pl: "Poziom z kwotami:", en: "Level with amounts:" },
  amountsText: {
    pl: " także kwoty; bez numerów kont, IBAN-ów i danych osobowych.",
    en: " amounts too; no account numbers, IBANs or personal data.",
  },
  copied: { pl: "Skopiowano", en: "Copied" },
  soon: { pl: "Dostępne wkrótce", en: "Coming soon" },
  configTitle: { pl: (name: string) => `${name} · konfiguracja`, en: (name: string) => `${name} · setup` },
  firstSteps: { pl: "Pierwsze kroki w aplikacji", en: "First steps in the app" },
  loadFailed: { pl: (err: string) => `Nie udało się pobrać stanu: ${err}`, en: (err: string) => `Could not load the state: ${err}` },
  overview: { pl: "Przegląd →", en: "Overview →" },
  configured: { pl: "Skonfigurowany.", en: "Set up." },
  noSteps: { pl: "Brak kroków konfiguracji.", en: "No setup steps." },
  withClaude: { pl: "Z pomocą Claude Code", en: "With Claude Code" },
  connectMcp: { pl: "Podłącz MCP do Claude Code", en: "Connect MCP to Claude Code" },
  oncePerProfile: { pl: "raz na profil", en: "once per profile" },
  desktopHint: { pl: "Claude Desktop: Ustawienia › Agent AI.", en: "Claude Desktop: Settings › AI agent." },
  runSkill: { pl: "Uruchom skill w Claude Code", en: "Run the skill in Claude Code" },
  settings: { pl: "Ustawienia", en: "Settings" },
});
