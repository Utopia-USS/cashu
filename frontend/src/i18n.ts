// UI language (docs/agents/localization.md). One app-wide language for the page lifetime: the user's
// choice from Settings (browser storage), else the OS / browser language when it is supported, else
// English. Changing it reloads the page, so formatters built at module load (format.ts) follow it.
// Outside a browser (node tests) the language is Polish until `setLanguageForTests` says otherwise.
//
// Every user-visible text lives in a `*.strings.ts` catalog: `catalog({ key: { pl: ..., en: ... } })`.
// An entry is a string or a function of its params; the compiler requires every language in every entry
// and the same type in each. The catalog resolves the language when a key is read, never at import.
// Pure module (no React): tested in tests/i18n.test.mjs.
import { readStored } from "./core/storage.ts";

export type Lang = "pl" | "en";
/** Supported languages in display order; adding one = a new member here + the compiler errors that follow. */
export const LANGS: readonly Lang[] = ["pl", "en"];
/** The language when neither the user nor the OS picks a supported one. */
export const FALLBACK_LANG: Lang = "en";
/** Each language's name in itself (the picker shows them untranslated). */
export const LANG_NAME: Record<Lang, string> = { pl: "Polski", en: "English" };

export const LANG_KEY = "cashu.lang";

const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

/** The first supported language in an ordered list of BCP 47 tags ("en-GB", "pl"), else null. */
export function matchLang(tags: readonly string[]): Lang | null {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return null;
}

/** The user's stored choice, or null for "follow the system". */
export function storedLang(): Lang | null {
  try {
    const v = readStored(globalThis.localStorage, LANG_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** The OS / browser language list (WKWebView and browsers expose the OS preference order). */
function systemTags(): string[] {
  const nav = globalThis.navigator as Navigator | undefined;
  if (!nav) return [];
  return nav.languages?.length ? [...nav.languages] : nav.language ? [nav.language] : [];
}

function resolve(): Lang {
  if (typeof window === "undefined") return "pl"; // node tests: the existing Polish assertions
  return storedLang() ?? matchLang(systemTags()) ?? FALLBACK_LANG;
}

let current: Lang | null = null;

/** The UI language. */
export function lang(): Lang {
  if (current === null) current = resolve();
  return current;
}

/** Store the user's choice (null = follow the system) and reload, so every module re-reads it. */
export function setLanguage(choice: Lang | null): void {
  try {
    if (choice === null) globalThis.localStorage?.removeItem(LANG_KEY);
    else globalThis.localStorage?.setItem(LANG_KEY, choice);
  } catch { /* storage unavailable: the choice holds until the reload */ }
  current = choice ?? null;
  globalThis.location?.reload();
}

/** Switch the language in node tests (catalogs read it on access). */
export function setLanguageForTests(l: Lang): void {
  current = l;
}

/** `render()` in every supported language (synchronous; the current language is restored). For a check like
 * "is this stored text still the generated default?", which must hold whichever language generated it. */
export function inEveryLang<T>(render: () => T): T[] {
  const saved = lang();
  try {
    return LANGS.map((l) => { current = l; return render(); });
  } finally {
    current = saved;
  }
}

/** The BCP 47 locale for Intl formatters: Polish formatting for pl; for en the OS's English variant
 * (en-GB, en-US, ...) when it has one, else en-US. */
export function intlLocale(): string {
  if (lang() === "pl") return "pl-PL";
  const en = systemTags().find((t) => /^en[-_]/i.test(t));
  return en ? en.replace("_", "-") : "en-US";
}

// ---- catalogs -------------------------------------------------------------------------------------

/** The Polish variant fixes an entry's type; every other language must match it. */
type Entries<T> = { [K in keyof T]: { pl: T[K] } & { [L in Exclude<Lang, "pl">]: NoInfer<T[K]> } };

/** A text catalog: `catalog({ save: { pl: "Zapisz", en: "Save" }, n: { pl: (n: number) => ..., en: ... } })`.
 * Reading `S.save` gives the entry in the current language. */
export function catalog<T extends Record<string, unknown>>(entries: Entries<T> & Record<string, Record<Lang, unknown>>): T {
  const out = {} as T;
  for (const key of Object.keys(entries) as (keyof T & string)[]) {
    Object.defineProperty(out, key, { get: () => entries[key][lang()], enumerable: true });
  }
  return out;
}

/** One inline text when a catalog entry would be overkill (a single use in a pure helper):
 * `tr({ pl: "Brak danych", en: "No data" })`. Prefer catalogs. */
export const tr = <T>(variants: { [L in Lang]: T }): T => variants[lang()];

// ---- plurals --------------------------------------------------------------------------------------

/** Polish word form: plForm(5, "reguła", "reguły", "reguł") -> "reguł" (2-4 few, but 12-14 many). */
export function plForm(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const n10 = abs % 10, n100 = abs % 100;
  if (abs === 1) return one;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
}

/** English word form: enForm(1, "rule", "rules") -> "rule". */
export const enForm = (n: number, one: string, other: string): string => (Math.abs(n) === 1 ? one : other);

/** "5 reguł" (number + Polish form). */
export const plCount = (n: number, one: string, few: string, many: string): string => `${n} ${plForm(n, one, few, many)}`;

/** "5 rules" (number + English form). */
export const enCount = (n: number, one: string, other: string): string => `${n} ${enForm(n, one, other)}`;

// ---- number input ---------------------------------------------------------------------------------

/** A typed number as `Number()` reads it: spaces dropped, the decimal comma as a dot. In English a comma
 * is a thousands separator when the text has a dot too ("1,234.5") or its groups are all three digits
 * ("12,500"); otherwise it is still a decimal comma ("1,5"), so Polish-style input keeps working. */
export function normalizeNumberInput(text: string): string {
  const t = text.replace(/[\s  ]/g, "");
  if (lang() === "en" && (t.includes(".") || /^-?\d{1,3}(,\d{3})+$/.test(t))) return t.replace(/,/g, "");
  return t.replace(",", ".");
}
