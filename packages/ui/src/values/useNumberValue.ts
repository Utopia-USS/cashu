import type { Decimal } from "@cashu/domain";
import { toBananas } from "@cashu/domain/core";
import {
  formatBananaValue,
  formatDecimalValue,
  type NumberDisplayOptions,
} from "@cashu/i18n/values";
import { useUiEnv } from "../environment/UiEnv.js";
import { valueStrings } from "./value.strings.js";

/** Shared display state; monetary values never expose their real digits while privacy is enabled:
 * money with a currency shows on the banana scale when the environment has one, the rest is masked. */
export function useNumberValue(value: Decimal | null, options: NumberDisplayOptions = {}) {
  const { locale, privacy, bananas } = useUiEnv();
  const language = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  if (privacy && !options.percent) {
    const b =
      bananas && options.currency && value !== null
        ? toBananas(bananas, value, options.currency)
        : null;
    if (b !== null) {
      const shown = formatBananaValue(b, locale, { signed: options.signed ?? false });
      return { ...shown, accessibleText: shown.text, hidden: false };
    }
    return {
      text: "•••",
      accessibleText: valueStrings.hidden[language],
      sign: 0 as const,
      hidden: true,
    };
  }
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
