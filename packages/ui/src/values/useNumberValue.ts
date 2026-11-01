import type { Decimal } from "@cashu/domain";
import { formatDecimalValue, type NumberDisplayOptions } from "@cashu/i18n/values";
import { useUiEnv } from "../environment/UiEnv.js";
import { valueStrings } from "./value.strings.js";

/** Shared display state; monetary values never expose digits or sign while privacy is enabled. */
export function useNumberValue(value: Decimal | null, options: NumberDisplayOptions = {}) {
  const { locale, privacy } = useUiEnv();
  const language = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  if (privacy && !options.percent)
    return {
      text: "•••",
      accessibleText: valueStrings.hidden[language],
      sign: 0 as const,
      hidden: true,
    };
  if (value === null)
    return {
      text: "-",
      accessibleText: valueStrings.unavailable[language],
      sign: 0 as const,
      hidden: false,
    };
  const formatted = formatDecimalValue(value, locale, options);
  return { ...formatted, accessibleText: formatted.text, hidden: false };
}
