import { ValueText } from "./platform.js";
import type { MoneyProps } from "./types.js";
import { useNumberValue } from "./useNumberValue.js";

/** A raw domain Money, rounded half-up to currency minor units unless fractionDigits is supplied.
 * Null displays a dash. Privacy replaces amount, currency, sign and tone with a neutral mask. */
export function Money({ value, fractionDigits, ...style }: MoneyProps) {
  const display = useNumberValue(value?.amount ?? null, {
    ...(value ? { currency: value.currency } : {}),
    ...(fractionDigits === undefined ? {} : { fractionDigits }),
  });
  return (
    <ValueText
      {...style}
      {...display}
      tone={display.hidden ? "default" : (style.tone ?? "default")}
    />
  );
}
