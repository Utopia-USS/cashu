import { lang } from "./lang.js";
import { normalizeNumberInputForLanguage } from "./numberInput.js";

/** UI wrapper: follows the current UI language. Backend callers pass an explicit language instead. */
export function normalizeNumberInput(text: string): string {
  return normalizeNumberInputForLanguage(text, lang());
}
