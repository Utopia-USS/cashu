import { ValueText } from "./platform.js";
import type { AmountProps } from "./types.js";
import { useNumberValue } from "./useNumberValue.js";

/** A raw Decimal, rounded half-up to two decimal places unless fractionDigits is supplied.
 * Null displays a dash. Privacy hides the number and any caller-provided sign tone. */
export function Amount({ value, fractionDigits, ...style }: AmountProps) {
  const display = useNumberValue(value, fractionDigits === undefined ? {} : { fractionDigits });
  return (
    <ValueText
      {...style}
      {...display}
      tone={display.hidden ? "default" : (style.tone ?? "default")}
    />
  );
}
