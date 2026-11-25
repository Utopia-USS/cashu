import type { Lang } from "./lang.js";

/** A typed number as `Number()` reads it: spaces dropped, the decimal comma as a dot. In English a comma
 * is a thousands separator when the text has a dot too ("1,234.5") or its groups are all three digits
 * ("12,500"); otherwise it is still a decimal comma ("1,5"), so Polish-style input keeps working. */
export function normalizeNumberInputForLanguage(text: string, language: Lang): string {
  const t = text.replace(/[\s  ]/g, "");
  if (language === "en" && (t.includes(".") || /^-?\d{1,3}(,\d{3})+$/.test(t)))
    return t.replace(/,/g, "");
  return t.replace(",", ".");
}
