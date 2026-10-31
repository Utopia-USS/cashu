/**
 * Decimal strings. The goldens carry `Decimal` as the exact text of Python's `str()` (`"0.00"`,
 * `"1E+1"`), and those strings feed hashes, so the default policy is an exact string match. The
 * `numeric` policy (per check, opt-in) treats two decimal strings as equal when they denote the same
 * number: `"1.0"` equals `"1.00"` and `"1E+1"` equals `"10"`. It never applies a tolerance.
 */
export type DecimalPolicy = "exact" | "numeric";

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_ALIGN = 4096;

interface Parsed {
  negative: boolean;
  coefficient: bigint;
  exponent: number;
}

function parseDecimal(s: string): Parsed | null {
  const m = DECIMAL.exec(s);
  if (m === null) return null;
  const frac = m[3] ?? "";
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp)) return null;
  return {
    negative: m[1] === "-",
    coefficient: BigInt(`${m[2]}${frac}`),
    exponent: exp - frac.length,
  };
}

/** True when the string has the shape of a plain or scientific decimal (`-1.50`, `1E+3`). */
export function isDecimalString(s: string): boolean {
  return DECIMAL.test(s);
}

/**
 * Same number, ignoring trailing zeros and the exponent form. Not equal for strings that are not
 * both decimals. Zero equals zero whatever its sign and scale.
 */
export function decimalsEqual(a: string, b: string): boolean {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (x === null || y === null) return false;
  if (x.coefficient === 0n || y.coefficient === 0n) return x.coefficient === y.coefficient;
  if (x.negative !== y.negative) return false;
  const shift = x.exponent - y.exponent;
  if (Math.abs(shift) > MAX_ALIGN) return false;
  if (shift >= 0) return x.coefficient * 10n ** BigInt(shift) === y.coefficient;
  return x.coefficient === y.coefficient * 10n ** BigInt(-shift);
}
