// Incognito: the header toggle that hides absolute amounts (money, quantities, money axes) and keeps the
// percentages. With a banana scale (`@cashu/domain` core/bananas.ts, set by the shell per profile) money
// shows as bananas instead of dots: `bananaMoney` converts, and `hideAmount` keeps banana text but masks
// every other digit, so a formatter that does not know the scale still hides its amount. The flag and the
// scale live here, outside React, so the plain formatters (format.ts, labels.ts) can read them; the shell
// re-renders and remounts the page on a change (`incognitoKey`). Keeping the flag between runs is the
// app's job: it installs an `IncognitoStore` at startup (browser storage in the desktop SPA, a convenience
// only). Every read and write through it is guarded, and the flag holds in memory when there is no store
// or it fails.

import { type BananaScale, toBananas } from "@cashu/domain/core";
import { intlLocale } from "@cashu/i18n";
import { BANANA, formatBananas } from "@cashu/i18n/values";

/** Where the app keeps the flag between runs. */
export interface IncognitoStore {
  /** The stored flag (false when nothing is stored). */
  load(): boolean;
  save(on: boolean): void;
}

const listeners = new Set<() => void>();
let store: IncognitoStore | null = null;
let state: boolean | null = null;
let scale: BananaScale | null = null;
let scaleVault: string | null = null;

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

/** The profile's banana scale (null: none known, incognito masks with dots). */
export function currentBananaScale(): BananaScale | null {
  return scale;
}

/** The vault the current scale belongs to (null: none set). */
export function bananaScaleVault(): string | null {
  return scale === null ? null : scaleVault;
}

const sameScale = (a: BananaScale | null, b: BananaScale | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.anchor === b.anchor &&
    a.perPln === b.perPln &&
    JSON.stringify(a.plnRates) === JSON.stringify(b.plnRates));

/** Set by the shell when the profile's anchor is known or changes; `vault` is the profile it is of. */
export function setBananaScale(next: BananaScale | null, vault: string | null = null): void {
  if (sameScale(next, scale) && (next === null || vault === scaleVault)) return;
  scale = next;
  scaleVault = next === null ? null : vault;
  for (const l of listeners) l();
}

/** Money shows on the banana scale right now (incognito on, scale known). */
export const showsBananas = (): boolean => isIncognito() && scale !== null;

/** One string per display state, for remount keys: "off", "masked" or the banana factor. */
export function incognitoKey(): string {
  if (!isIncognito()) return "off";
  return scale === null ? "masked" : `bananas:${scaleVault}:${scale.anchor}:${scale.perPln}`;
}

/** Money in incognito with a scale: its banana text, or null (no scale, no rate: mask instead). */
export function bananaMoney(
  amount: number | null | undefined,
  currency: string,
  options: { readonly signed?: boolean } = {},
): string | null {
  if (!isIncognito() || scale === null || amount == null) return null;
  const b = toBananas(scale, amount, currency);
  return b === null ? null : formatBananas(b, intlLocale(), options);
}

/** The digits of a formatted amount as dots, sign and unit kept: "-11 600,00 zł" -> "-••• zł". */
export const maskDigits = (text: string): string => text.replace(/\d(?:[\d\s  .,]*\d)?/g, "•••");

/** `text` masked while incognito is on, else unchanged. Banana text is already safe and stays. */
export const hideAmount = (text: string): string =>
  isIncognito() && !text.includes(BANANA) ? maskDigits(text) : text;
