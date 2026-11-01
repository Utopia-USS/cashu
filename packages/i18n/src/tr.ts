// Backend language contexts. Platform adapters own settings.json, CASHU_LANG and OS detection;
// request and worker translators are explicit so overlapping async work never changes UI globals.
import { pyStrip } from "@cashu/domain/text";
import { FALLBACK_LANG, type Lang, lang } from "./lang.js";

export const LANG_HEADER = "x-cashu-lang";
export const LANG_ENV = "CASHU_LANG";

export type TranslationVariants<T> = Readonly<Record<Lang, T>>;

/** Python core/i18n.py parse_lang: locale tags and POSIX locale strings, or null. */
export function parseLang(value: unknown): Lang | null {
  if (typeof value !== "string") return null;
  // Python str.strip includes the four information separators and U+0085, but not JS trim's BOM.
  const stripped = pyStrip(value);
  const base = stripped.toLowerCase().replace(/_/g, "-").split("-")[0]?.split(".")[0];
  return base === "pl" || base === "en" ? base : null;
}

/** Inline variants, compatible with S33's UI tr(). Backend code binds a Translator instead. */
export const tr = <T>(variants: TranslationVariants<T>): T => variants[lang()];

/** Immutable language for one request or run. Safe to keep across awaits and pass to pure helpers. */
export interface Translator {
  readonly language: Lang;
  tr<T>(variants: TranslationVariants<T>): T;
}

/** Pin one run explicitly (MCP uses pl), without touching app settings or the UI language. */
export function createTranslator(language: Lang): Translator {
  return Object.freeze({
    language,
    tr: <T>(variants: TranslationVariants<T>): T => variants[language],
  });
}

/** A platform adapter for one settings location. Reads return untrusted boundary values; missing or
 * unreadable settings / locale are treated as no choice. No disk, process or browser APIs here. */
export interface BackendLanguageSource {
  /** CASHU_LANG (e.g. the test pin), not the HTTP header. */
  environmentLanguage(): unknown;
  /** The language field of settings.json, or null if absent / malformed. */
  storedLanguage(): unknown;
  /** First supported OS preference, else the effective locale environment value, else null. */
  osLanguage(): unknown;
  /** Atomically update only the language field, preserving other settings. May throw on IO failure. */
  rememberLanguage(language: Lang): void;
}

export interface BackendI18n {
  /** Outside a request: environment override, remembered language, OS, English. Re-read on each run. */
  appLanguage(): Lang;
  /** Pass the X-Cashu-Lang header value (HTTP or websocket). Valid headers are remembered best effort;
   * invalid / missing headers fall back to appLanguage(). The returned context never changes. */
  forRequest(headerValue?: unknown): Translator;
}

function readValue(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return null;
  }
}

/** One instance per platform settings location, not a global singleton. Request contexts always
 * outrank the app override, matching Python's ContextVar; persistence failure never drops a request. */
export function createBackendI18n(source: BackendLanguageSource): BackendI18n {
  let remembered: Lang | null = null;

  function appLanguage(): Lang {
    return (
      parseLang(readValue(() => source.environmentLanguage())) ??
      parseLang(readValue(() => source.storedLanguage())) ??
      parseLang(readValue(() => source.osLanguage())) ??
      FALLBACK_LANG
    );
  }

  function remember(language: Lang): void {
    if (remembered === language) return;
    try {
      if (readValue(() => source.storedLanguage()) !== language) source.rememberLanguage(language);
      remembered = language;
    } catch {
      // Read-only settings must not prevent rendering; retry on the next valid request.
    }
  }

  return Object.freeze({
    appLanguage,
    forRequest(headerValue?: unknown): Translator {
      const requested = parseLang(headerValue);
      if (requested !== null) remember(requested);
      return createTranslator(requested ?? appLanguage());
    },
  });
}
