/**
 * Python float semantics the performance math depends on, beyond IEEE arithmetic (which JS shares):
 * the compensated `sum()` of CPython 3.12+, `float(Fraction)` and the `round` / `repr` helpers of
 * `decimal.ts`. Floats appear only where the Python code uses float (returns, ratios, the combined
 * series); money stays `Decimal` until it reaches the return math.
 */

import type { Fraction } from "../portfolio/fraction.js";

/**
 * Python `sum(values)` of floats (start `0`): CPython 3.12+ adds floats with Neumaier's compensated
 * summation and adds the compensation once at the end, so a plain left fold can differ in the last
 * bits. An empty input is Python's int `0` (as a float here: every caller wraps it in `float()` or
 * rounds it).
 */
export function pySum(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) compensation += total - t + x;
    else compensation += x - t + total;
    total = t;
  }
  if (compensation !== 0 && Number.isFinite(compensation)) total += compensation;
  return total;
}

/**
 * Python `float(Fraction)`: `numerator / denominator` correctly rounded (Python's int true division).
 * The quotient is taken with 55 significant bits plus a sticky bit, which `Number(bigint)` rounds
 * half-even to 53 bits exactly once.
 */
export function fractionToFloat(value: Fraction): number {
  const negative = value.numerator < 0n;
  const n = negative ? -value.numerator : value.numerator;
  const d = value.denominator;
  if (n === 0n) return 0;
  // shift so that the integer quotient has 55 bits
  const shift = 55 - (bitLength(n) - bitLength(d));
  const scaledN = shift >= 0 ? n << BigInt(shift) : n;
  const scaledD = shift >= 0 ? d : d << BigInt(-shift);
  let q = scaledN / scaledD;
  if (scaledN % scaledD !== 0n) q |= 1n;
  const result = Number(q) * 2 ** -shift;
  return negative ? -result : result;
}

function bitLength(x: bigint): number {
  return x.toString(2).length;
}
