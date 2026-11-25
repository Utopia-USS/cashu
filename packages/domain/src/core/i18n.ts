/**
 * The UI language of a registry label. Domain has no ambient language (Python's `core.i18n.tr` reads
 * the request's language): callers pass it.
 */
export type UiLang = "pl" | "en";

/** Python `tr(pl=..., en=en or pl)`: the English text falls back to the Polish one. */
export function pickLabel(lang: UiLang, pl: string, en: string | null | undefined): string {
  return lang === "en" ? en || pl : pl;
}
