import { ValueText } from "./platform.js";
import type { DeltaProps } from "./types.js";
import { useNumberValue } from "./useNumberValue.js";

/** A raw Money or Decimal change, with the same precision as Money, Amount or Percent.
 * Positive values show a plus and gain tone, negative values show a minus and loss tone.
 * Rounded zero has no sign or gain/loss tone. Null displays a dash; privacy masks monetary
 * and unitless changes, including their sign and tone, while ratio changes remain visible. */
export function Delta({ value, kind, fractionDigits, ...style }: DeltaProps) {
  const amount = kind === "money" ? (value?.amount ?? null) : value;
  const display = useNumberValue(amount, {
    signed: true,
    ...(kind === "money" && value ? { currency: value.currency } : {}),
    ...(kind === "percent" ? { percent: true } : {}),
    ...(fractionDigits === undefined ? {} : { fractionDigits }),
  });
  const tone = display.sign > 0 ? "positive" : display.sign < 0 ? "negative" : "default";
  return <ValueText {...style} {...display} tone={tone} />;
}
