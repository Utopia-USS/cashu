import { formatCalendarDate } from "@cashu/i18n/values";
import { useUiEnv } from "../environment/UiEnv.js";
import { ValueText } from "./platform.js";
import type { DateTextProps } from "./types.js";
import { valueStrings } from "./value.strings.js";

/** A raw ISO calendar date (YYYY-MM-DD), localized in the medium date style by default.
 * Dates never shift with the device timezone and remain visible in privacy mode.
 * Null displays a dash; invalid dates are rejected by the domain parser. */
export function DateText({ value, dateStyle, ...style }: DateTextProps) {
  const { locale } = useUiEnv();
  const language = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const text = value === null ? "-" : formatCalendarDate(value, locale, dateStyle);
  return (
    <ValueText
      {...style}
      text={text}
      accessibleText={value === null ? valueStrings.unavailable[language] : text}
    />
  );
}
