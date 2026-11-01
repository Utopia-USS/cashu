import { ValueText } from "./platform.js";
import type { PercentProps } from "./types.js";
import { useNumberValue } from "./useNumberValue.js";

/** A raw Decimal ratio (0.125 is 12.5%), rounded half-up to one decimal by default.
 * Null displays a dash. Shares remain visible in privacy mode. */
export function Percent({ value, fractionDigits, ...style }: PercentProps) {
  const display = useNumberValue(value, {
    percent: true,
    ...(fractionDigits === undefined ? {} : { fractionDigits }),
  });
  return <ValueText {...style} {...display} />;
}
