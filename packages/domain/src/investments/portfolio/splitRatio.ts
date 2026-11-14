/** Exact split ratios: the fraction a split transaction's decimal `splitRatio` stands for (`split_ratio.py`). */

import type { Decimal } from "../../decimal.js";
import { Fraction } from "./fraction.js";

/** Largest denominator `splitFraction` recovers (a 1:10000 reverse split). */
export const SPLIT_RATIO_MAX_DENOMINATOR = 10_000n;

/**
 * A recovered fraction `p/q` needs `q * q * ulp <= 1/1000` (`ulp` = one unit in the last place of the
 * decimal ratio): the decimal must carry enough digits that matching `p/q` is no coincidence.
 */
const SPLIT_RATIO_MIN_EVIDENCE: Fraction = Fraction.of(1n, 1000n);

/**
 * The exact new-per-old fraction of a positive, finite split ratio.
 *
 * - a decimal whose exact value has a denominator <= `SPLIT_RATIO_MAX_DENOMINATOR` is exact as
 *   written (`4`, `1.5`, `0.02` = 1:50, `0.3333` = 3333/10000);
 * - otherwise the closest `p/q` with `q` <= that bound is used when it is less than one unit in the
 *   last place away and satisfies `SPLIT_RATIO_MIN_EVIDENCE` (`0.3333333333` -> 1/3);
 * - anything else is used exactly as written (`1.0456723`).
 */
export function splitFraction(ratio: Decimal): Fraction {
  const exact = Fraction.fromDecimal(ratio);
  const candidate = exact.limitDenominator(SPLIT_RATIO_MAX_DENOMINATOR);
  if (candidate.eq(exact)) return exact;
  const places = decimalPlaces(exact);
  if (places === null) return exact; // unreachable: a Decimal always has a finite decimal
  const ulp = Fraction.of(1n, 10n ** BigInt(places));
  const close = candidate.sub(exact).abs().lt(ulp);
  const evidence = Fraction.of(candidate.denominator ** 2n).mul(ulp);
  if (close && evidence.compare(SPLIT_RATIO_MIN_EVIDENCE) <= 0) return candidate;
  return exact;
}

/**
 * Places after the point of `value` written as a finite decimal (3/2 -> 1, 5 -> 0), or null when it
 * has no finite decimal (1/3).
 */
export function decimalPlaces(value: Fraction): number | null {
  let denominator = value.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos++;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives++;
  }
  return denominator === 1n ? Math.max(twos, fives) : null;
}
