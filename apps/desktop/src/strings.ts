/** Every text the shell itself shows exists in Polish and English (docs/agents/localization.md):
 * the loading and error pages, the tray menu and the notification fallbacks. The language follows
 * the OS, else English; CASHU_LANG pins it. The dashboard itself localizes through the SPA. */

export type Lang = "pl" | "en";

export const STRINGS = {
  loading: { pl: "Uruchamianie cashU…", en: "Starting cashU…" },
  startFailedTitle: { pl: "Nie udało się uruchomić cashU", en: "cashU could not start" },
  logHint: { pl: "Szczegóły w logu: ", en: "Details in the log: " },
  alreadyRunning: {
    pl: "cashU jest już otwarty; jego okno wysunięto na wierzch.",
    en: "cashU is already open; its window was brought to the front.",
  },
  trayOpen: { pl: "Otwórz cashU", en: "Open cashU" },
  trayQuit: { pl: "Zakończ cashU", en: "Quit cashU" },
  trayTooltip: { pl: "cashU", en: "cashU" },
} as const satisfies Record<string, Record<Lang, string>>;

export type StringKey = keyof typeof STRINGS;

export function pickLang(pinned: string | undefined, osLocale: string | undefined): Lang {
  const pin = pinned?.trim().toLowerCase();
  if (pin === "pl" || pin === "en") return pin;
  return osLocale?.toLowerCase().startsWith("pl") ? "pl" : "en";
}

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[key][lang];
}
