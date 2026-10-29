// Incognito: the header toggle that hides absolute amounts (money, quantities, money axes) and keeps the
// percentages. The flag lives here, outside React, so the plain formatters (format.ts, labels.ts) can read it;
// the shell re-renders and remounts the page on a change. Browser storage is a convenience only: every read
// and write is guarded and the flag holds in memory when storage is unavailable.
import { readStored } from "./core/storage.ts";

export const INCOGNITO_KEY = "cashu.incognito";

const listeners = new Set<() => void>();
let state: boolean | null = null;

/** Amounts are hidden. */
export function isIncognito(): boolean {
  if (state === null) {
    try { state = readStored(globalThis.localStorage, INCOGNITO_KEY) === "1"; } catch { state = false; }
  }
  return state;
}

export function setIncognito(on: boolean): void {
  state = on;
  try { globalThis.localStorage?.setItem(INCOGNITO_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}

/** Subscribe to changes (useSyncExternalStore). Returns the unsubscribe. */
export function onIncognitoChange(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The digits of a formatted amount as dots, sign and unit kept: "-11 600,00 zł" -> "-••• zł". */
export const maskDigits = (text: string): string => text.replace(/\d(?:[\d\s  .,]*\d)?/g, "•••");

/** `text` masked while incognito is on, else unchanged. */
export const hideAmount = (text: string): string => (isIncognito() ? maskDigits(text) : text);
