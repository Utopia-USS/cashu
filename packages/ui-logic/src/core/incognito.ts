// Incognito: the header toggle that hides absolute amounts (money, quantities, money axes) and keeps the
// percentages. The flag lives here, outside React, so the plain formatters (format.ts, labels.ts) can read it;
// the shell re-renders and remounts the page on a change. Keeping the flag between runs is the app's job: it
// installs an `IncognitoStore` at startup (browser storage in the desktop SPA, a convenience only). Every read
// and write through it is guarded, and the flag holds in memory when there is no store or it fails.

/** Where the app keeps the flag between runs. */
export interface IncognitoStore {
  /** The stored flag (false when nothing is stored). */
  load(): boolean;
  save(on: boolean): void;
}

const listeners = new Set<() => void>();
let store: IncognitoStore | null = null;
let state: boolean | null = null;

/** Wire the app's persistence once at startup, before the first render reads the flag. */
export function installIncognitoStore(s: IncognitoStore): void {
  store = s;
  state = null;
}

/** Amounts are hidden. */
export function isIncognito(): boolean {
  if (state === null) {
    try {
      state = store?.load() ?? false;
    } catch {
      state = false;
    }
  }
  return state;
}

export function setIncognito(on: boolean): void {
  state = on;
  try {
    store?.save(on);
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
}

/** Subscribe to changes (useSyncExternalStore). Returns the unsubscribe. */
export function onIncognitoChange(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The digits of a formatted amount as dots, sign and unit kept: "-11 600,00 zł" -> "-••• zł". */
export const maskDigits = (text: string): string => text.replace(/\d(?:[\d\s  .,]*\d)?/g, "•••");

/** `text` masked while incognito is on, else unchanged. */
export const hideAmount = (text: string): string => (isIncognito() ? maskDigits(text) : text);
