import { type Lang, t } from "./strings.js";

export type TrayAction = "open" | "quit";
export type TrayItem = { label: string; action: TrayAction } | { separator: true };

/** The tray menu (pure: main.ts turns it into an Electron menu). */
export function trayItems(lang: Lang): TrayItem[] {
  return [
    { label: t(lang, "trayOpen"), action: "open" },
    { separator: true },
    { label: t(lang, "trayQuit"), action: "quit" },
  ];
}
