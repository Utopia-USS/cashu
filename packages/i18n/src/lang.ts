// The UI language (docs/agents/localization.md): one app-wide language for the app's lifetime. The user's
// pin from Settings, else the first supported language of the OS preference list, else English. Changing
// the pin restarts the UI (a page reload on the desktop), so formatters built at module load follow it.
//
// Platform free: the app installs a `LanguageSource` at startup (browser storage + navigator in the
// desktop SPA, settings + the OS locale list on the phone) before any module reads the language. Without a
// source (scripts, node tests) there is no pin and no OS list, so the language is English until
// `setLanguageForTests` says otherwise.

export type Lang = "pl" | "en";
/** Supported languages in display order; adding one = a new member here + the compiler errors that follow. */
export const LANGS: readonly Lang[] = ["pl", "en"];
/** The language when neither the user nor the OS picks a supported one. */
export const FALLBACK_LANG: Lang = "en";
/** Each language's name in itself (the picker shows them untranslated). */
export const LANG_NAME: Record<Lang, string> = { pl: "Polski", en: "English" };

/** Where the app keeps the user's choice and reads the OS languages. */
export interface LanguageSource {
  /** The stored pin as written by `pin` (anything else, or nothing, means "follow the system"). */
  pinned(): string | null;
  /** The OS preference list, BCP 47 tags in order ("en-GB", "pl-PL"). */
  systemTags(): readonly string[];
  /** Store the pin (null = follow the system) and restart the UI, so every module re-reads it. */
  pin(choice: Lang | null): void;
}

const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

let source: LanguageSource | null = null;
let current: Lang | null = null;

/** Wire the platform once at startup, before the first `lang()` (module-level formatters read it on import). */
export function installLanguageSource(s: LanguageSource): void {
  source = s;
  current = null;
}

/** The first supported language in an ordered list of BCP 47 tags ("en-GB", "pl"), else null. */
export function matchLang(tags: readonly string[]): Lang | null {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return null;
}

/** The user's pinned choice, or null for "follow the system". */
export function pinnedLang(): Lang | null {
  try {
    const v = source?.pinned() ?? null;
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

function systemTags(): readonly string[] {
  return source?.systemTags() ?? [];
}

/** The UI language. */
export function lang(): Lang {
  if (current === null) current = pinnedLang() ?? matchLang(systemTags()) ?? FALLBACK_LANG;
  return current;
}

/** Pin the language (null = follow the system); the source stores it and restarts the UI. */
export function setLanguage(choice: Lang | null): void {
  current = choice ?? null;
  source?.pin(choice);
}

/** Switch the language in tests (catalogs read it on access). */
export function setLanguageForTests(l: Lang): void {
  current = l;
}

/** `render()` in every supported language (synchronous; the current language is restored). For a check like
 * "is this stored text still the generated default?", which must hold whichever language generated it. */
export function inEveryLang<T>(render: () => T): T[] {
  const saved = lang();
  try {
    return LANGS.map((l) => {
      current = l;
      return render();
    });
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
