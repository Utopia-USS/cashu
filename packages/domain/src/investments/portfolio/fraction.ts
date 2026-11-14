/**
 * Exact rationals over `bigint`: the subset of Python's `fractions.Fraction` the portfolio math uses
 * (lot quantities after splits, split ratios). Always normalized: the denominator is positive and
 * coprime with the numerator, so two equal values have equal fields.
 */

import { Decimal } from "../../decimal.js";

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Python `a // b` (floor division) for bigints. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export class Fraction {
  readonly numerator: bigint;
  /** Always > 0. */
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
  }

  /** `Fraction(numerator, denominator)`, normalized. */
  static of(numerator: bigint | number, denominator: bigint | number = 1n): Fraction {
    let n = BigInt(numerator);
    let d = BigInt(denominator);
    if (d === 0n) throw new RangeError("Fraction denominator 0");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return g > 1n ? new Fraction(n / g, d / g) : new Fraction(n, d);
  }

  /** `Fraction(Decimal)`: the exact value (`-0` is 0). */
  static fromDecimal(value: Decimal): Fraction {
    const coefficient = BigInt(value.digits) * (value.sign ? -1n : 1n);
    if (value.exp >= 0) return Fraction.of(coefficient * 10n ** BigInt(value.exp));
    return Fraction.of(coefficient, 10n ** BigInt(-value.exp));
  }

  add(other: Fraction): Fraction {
    return Fraction.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: Fraction): Fraction {
    return Fraction.of(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other: Fraction): Fraction {
    return Fraction.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  div(other: Fraction): Fraction {
    return Fraction.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  abs(): Fraction {
    return this.numerator < 0n ? new Fraction(-this.numerator, this.denominator) : this;
  }

  /** -1, 0 or 1. */
  compare(other: Fraction): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  eq(other: Fraction): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  lt(other: Fraction): boolean {
    return this.compare(other) < 0;
  }

  gt(other: Fraction): boolean {
    return this.compare(other) > 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /** Python `round(fraction)`: the nearest integer, ties to even. */
  round(): bigint {
    const floor = floorDiv(this.numerator, this.denominator);
    const twice = (this.numerator - floor * this.denominator) * 2n;
    if (twice < this.denominator) return floor;
    if (twice > this.denominator) return floor + 1n;
    return floor % 2n === 0n ? floor : floor + 1n;
  }

  /** Python `Fraction.limit_denominator(max)`: the closest fraction with denominator <= `max`. */
  limitDenominator(maxDenominator: bigint): Fraction {
    if (maxDenominator < 1n) throw new RangeError("max_denominator should be at least 1");
    if (this.denominator <= maxDenominator) return this;
    let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
    let n = this.numerator;
    let d = this.denominator;
    for (;;) {
      const a = floorDiv(n, d);
      const q2 = q0 + a * q1;
      if (q2 > maxDenominator) break;
      [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
      [n, d] = [d, n - a * d];
    }
    const k = floorDiv(maxDenominator - q0, q1);
    // CPython 3.12: the closer of (p0 + k p1) / (q0 + k q1) and p1 / q1 (ties to p1 / q1).
    if (2n * d * (q0 + k * q1) <= this.denominator) return Fraction.of(p1, q1);
    return Fraction.of(p0 + k * p1, q0 + k * q1);
  }

  /** Exact `Decimal(numerator)` and `Decimal(denominator)`, for decimal division. */
  parts(): readonly [Decimal, Decimal] {
    return [Decimal.fromInt(this.numerator), Decimal.fromInt(this.denominator)];
  }
}

export const FRACTION_ZERO: Fraction = Fraction.of(0n);
