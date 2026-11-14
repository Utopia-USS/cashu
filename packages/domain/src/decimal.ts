/**
 * Exact decimals with Python `decimal` semantics (CPython's libmpdec), for money and every value that
 * feeds a dedup hash or a global id.
 *
 * A value is Python's triple: sign, coefficient digits and exponent (`Decimal("1.50")` is
 * `(0, "150", -2)`), so `toString()` matches `str(Decimal)` exactly (`1E+1`, `1.50`, `-0`,
 * `1.23E-7`) and arithmetic keeps Python's exponents (`1.50 + 2` is `3.50`). Rounding, contexts,
 * `quantize`, `normalize`, integer powers and `format(d, spec)` are ports of `_pydecimal.py` /
 * libmpdec. `decimal.js` is deliberately not used: it normalises the exponent away (`1.50` -> `1.5`),
 * which would break `str()` / `format(d, "f")` parity and with it the dedup hashes (risk R1).
 *
 * Signals: InvalidOperation, DivisionByZero and Overflow are trapped (thrown as `DecimalError`), as in
 * Python's default context; every other signal (Inexact, Rounded, Clamped, Subnormal, Underflow) is
 * silent. Infinity and NaN are not representable: Python inputs or results that would be non-finite
 * throw `DecimalError("NonFinite")`.
 */

import { isPySpace, unicodeDecimal } from "./text.js";

export type Rounding =
  | "ROUND_DOWN"
  | "ROUND_HALF_UP"
  | "ROUND_HALF_EVEN"
  | "ROUND_CEILING"
  | "ROUND_FLOOR"
  | "ROUND_UP"
  | "ROUND_HALF_DOWN"
  | "ROUND_05UP";

export interface DecimalContext {
  readonly prec: number;
  readonly rounding: Rounding;
  readonly Emin: number;
  readonly Emax: number;
}

export type DecimalSignal = "InvalidOperation" | "DivisionByZero" | "Overflow" | "NonFinite";

/** A trapped decimal signal (Python raises `decimal.<signal>`); `NonFinite` = Python would give inf/NaN. */
export class DecimalError extends Error {
  readonly signal: DecimalSignal;
  constructor(signal: DecimalSignal, message: string) {
    super(`${signal}: ${message}`);
    this.name = "DecimalError";
    this.signal = signal;
  }
}

/** Python's `decimal.DefaultContext`: 28 significant digits, ROUND_HALF_EVEN. */
export const DEFAULT_CONTEXT: DecimalContext = Object.freeze({
  prec: 28,
  rounding: "ROUND_HALF_EVEN",
  Emin: -999999,
  Emax: 999999,
});

/** `decimal.Context(prec=..., rounding=...)`: unspecified fields come from the default context. */
export function makeContext(fields: Partial<DecimalContext>): DecimalContext {
  return Object.freeze({ ...DEFAULT_CONTEXT, ...fields });
}

let current: DecimalContext = DEFAULT_CONTEXT;

/** Python `decimal.getcontext()`. */
export function getContext(): DecimalContext {
  return current;
}

/** Python `with localcontext(ctx):` for a synchronous block (never await inside `fn`). */
export function localContext<T>(ctx: DecimalContext, fn: () => T): T {
  const previous = current;
  current = ctx;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

const ZEROS_ONLY = /^0*$/;

function zeros(n: number): string {
  return n > 0 ? "0".repeat(n) : "";
}

function stripLeadingZeros(digits: string): string {
  const s = digits.replace(/^0+/, "");
  return s === "" ? "0" : s;
}

function etiny(ctx: DecimalContext): number {
  return ctx.Emin - ctx.prec + 1;
}

function etop(ctx: DecimalContext): number {
  return ctx.Emax - ctx.prec + 1;
}

function digitCount(n: number): number {
  return String(Math.abs(n)).length;
}

type Sign = 0 | 1;

export class Decimal {
  /** 1 for negative (including `-0`), 0 otherwise. */
  readonly sign: Sign;
  /** Coefficient digits without leading zeros (`"0"` for zero). */
  readonly digits: string;
  /** Exponent: value = (-1)^sign * digits * 10^exp. */
  readonly exp: number;

  private constructor(sign: Sign, digits: string, exp: number) {
    this.sign = sign;
    this.digits = digits;
    this.exp = exp;
  }

  // ------------------------------------------------------------------ construction

  /** Python `Decimal((sign, digits, exp))`. */
  static fromTriple(sign: Sign, digits: string, exp: number): Decimal {
    if (!/^\d+$/.test(digits)) throw new TypeError(`invalid coefficient ${digits}`);
    if (!Number.isSafeInteger(exp)) throw new TypeError(`invalid exponent ${exp}`);
    return new Decimal(sign, stripLeadingZeros(digits), exp);
  }

  /** Python `Decimal(text)`: exact (never rounded to a context), libmpdec's syntax rules. */
  static parse(text: string): Decimal {
    const chars = Array.from(text);
    let start = 0;
    let end = chars.length;
    const cpAt = (i: number) => (chars[i] as string).codePointAt(0) as number;
    while (end > 0 && isPySpace(cpAt(end - 1))) end--;
    while (start < end && isPySpace(cpAt(start))) start++;
    let ascii = "";
    for (let i = start; i < end; i++) {
      const ch = chars[i] as string;
      const cp = cpAt(i);
      if (ch === "_") continue;
      if (cp > 0 && cp <= 127) {
        ascii += ch;
      } else if (isPySpace(cp)) {
        ascii += " ";
      } else {
        const d = unicodeDecimal(cp);
        if (d < 0) throw invalidLiteral(text);
        ascii += String(d);
      }
    }
    const m = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(ascii);
    if (!m) {
      if (/^[+-]?(?:inf|infinity|nan\d*|snan\d*)$/i.test(ascii)) {
        throw new DecimalError("NonFinite", `non-finite literal ${JSON.stringify(text)}`);
      }
      throw invalidLiteral(text);
    }
    const sign: Sign = m[1] === "-" ? 1 : 0;
    const intPart = m[2] ?? "";
    const fracPart = m[3] ?? m[4] ?? "";
    let exp = 0;
    if (m[5] !== undefined) {
      exp = Number(m[5]);
      if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1e15) throw invalidLiteral(text);
    }
    return new Decimal(sign, stripLeadingZeros(intPart + fracPart), exp - fracPart.length);
  }

  /** Python `Decimal(int)`. */
  static fromInt(n: bigint | number): Decimal {
    if (typeof n === "number" && !Number.isSafeInteger(n)) {
      throw new TypeError(`not a safe integer: ${n}`);
    }
    const big = BigInt(n);
    return big < 0n ? new Decimal(1, (-big).toString(), 0) : new Decimal(0, big.toString(), 0);
  }

  /** Python `Decimal(float)`: the exact binary value (`Decimal(0.1)` has 55 digits). */
  static fromFloat(x: number): Decimal {
    if (!Number.isFinite(x)) throw new DecimalError("NonFinite", `non-finite float ${x}`);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const sign: Sign = hi >>> 31 === 1 ? 1 : 0;
    const biased = (hi >>> 20) & 0x7ff;
    let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let e2: number;
    if (biased === 0) {
      e2 = -1074;
    } else {
      mantissa |= 1n << 52n;
      e2 = biased - 1075;
    }
    if (mantissa === 0n) return new Decimal(sign, "0", 0);
    while (e2 < 0 && (mantissa & 1n) === 0n) {
      mantissa >>= 1n;
      e2++;
    }
    if (e2 >= 0) return new Decimal(sign, (mantissa << BigInt(e2)).toString(), 0);
    return new Decimal(sign, (mantissa * 5n ** BigInt(-e2)).toString(), e2);
  }

  // ------------------------------------------------------------------ inspection

  isZero(): boolean {
    return this.digits === "0";
  }

  /** True for negative values and `-0` (Python `is_signed()`). */
  isSigned(): boolean {
    return this.sign === 1;
  }

  /** Python `adjusted()`: exponent of the most significant digit. */
  adjusted(): number {
    return this.exp + this.digits.length - 1;
  }

  /** Python `str(d)` (scientific notation when the exponent is positive or the value is tiny). */
  toString(): string {
    const sign = this.sign ? "-" : "";
    const len = this.digits.length;
    const leftdigits = this.exp + len;
    const dotplace = this.exp <= 0 && leftdigits > -6 ? leftdigits : 1;
    let intpart: string;
    let fracpart: string;
    if (dotplace <= 0) {
      intpart = "0";
      fracpart = `.${zeros(-dotplace)}${this.digits}`;
    } else if (dotplace >= len) {
      intpart = this.digits + zeros(dotplace - len);
      fracpart = "";
    } else {
      intpart = this.digits.slice(0, dotplace);
      fracpart = `.${this.digits.slice(dotplace)}`;
    }
    const e = leftdigits - dotplace;
    const exp = e === 0 ? "" : `E${e > 0 ? "+" : "-"}${Math.abs(e)}`;
    return sign + intpart + fracpart + exp;
  }

  toJSON(): string {
    return this.toString();
  }

  /** Python `int(d)`: truncated toward zero. */
  toBigInt(): bigint {
    let text: string;
    if (this.exp >= 0) text = this.digits + zeros(this.exp);
    else {
      const keep = this.digits.length + this.exp;
      text = keep > 0 ? this.digits.slice(0, keep) : "0";
    }
    const big = BigInt(text);
    return this.sign ? -big : big;
  }

  /** Python `float(d)` (correctly rounded). Only where the Python code itself goes to float. */
  toFloat(): number {
    return Number(this.toString());
  }

  // ------------------------------------------------------------------ comparison

  /** -1, 0 or 1 by value (`-0 == 0`, `1.0 == 1`). */
  compare(other: Decimal): -1 | 0 | 1 {
    if (this.isZero()) {
      if (other.isZero()) return 0;
      return other.sign ? 1 : -1;
    }
    if (other.isZero()) return this.sign ? -1 : 1;
    if (other.sign < this.sign) return -1;
    if (this.sign < other.sign) return 1;
    const pos: -1 | 1 = this.sign ? -1 : 1;
    const neg: -1 | 1 = this.sign ? 1 : -1;
    const sa = this.adjusted();
    const oa = other.adjusted();
    if (sa === oa) {
      const sp = this.digits + zeros(this.exp - other.exp);
      const op = other.digits + zeros(other.exp - this.exp);
      if (sp === op) return 0;
      return sp < op ? neg : pos;
    }
    return sa > oa ? pos : neg;
  }

  eq(other: Decimal): boolean {
    return this.compare(other) === 0;
  }
  lt(other: Decimal): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Decimal): boolean {
    return this.compare(other) <= 0;
  }
  gt(other: Decimal): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Decimal): boolean {
    return this.compare(other) >= 0;
  }

  // ------------------------------------------------------------------ rounding core (_pydecimal)

  private roundingResult(rounding: Rounding, keep: number): number {
    const d = this.digits;
    const allZeros = ZEROS_ONLY.test(d.slice(keep));
    const down = allZeros ? 0 : -1;
    const halfUp = () => ("56789".includes(d[keep] as string) ? 1 : down);
    const exactHalf = () => d[keep] === "5" && ZEROS_ONLY.test(d.slice(keep + 1));
    switch (rounding) {
      case "ROUND_DOWN":
        return down;
      case "ROUND_UP":
        return -down;
      case "ROUND_HALF_UP":
        return halfUp();
      case "ROUND_HALF_DOWN":
        return exactHalf() ? -1 : halfUp();
      case "ROUND_HALF_EVEN":
        return exactHalf() && (keep === 0 || "02468".includes(d[keep - 1] as string))
          ? -1
          : halfUp();
      case "ROUND_CEILING":
        return this.sign ? down : -down;
      case "ROUND_FLOOR":
        return this.sign ? -down : down;
      case "ROUND_05UP":
        return keep > 0 && !"05".includes(d[keep - 1] as string) ? down : -down;
    }
  }

  /** `_rescale`: exactly `exp` as exponent, rounding with `rounding`; no context checks. */
  rescale(exp: number, rounding: Rounding): Decimal {
    if (this.isZero()) return new Decimal(this.sign, "0", exp);
    if (this.exp >= exp) return new Decimal(this.sign, this.digits + zeros(this.exp - exp), exp);
    let self: Decimal = this;
    let keep = this.digits.length + this.exp - exp;
    if (keep < 0) {
      self = new Decimal(this.sign, "1", exp - 1);
      keep = 0;
    }
    const changed = self.roundingResult(rounding, keep);
    let coeff = self.digits.slice(0, keep) || "0";
    if (changed === 1) coeff = (BigInt(coeff) + 1n).toString();
    return new Decimal(this.sign, coeff, exp);
  }

  /** `_fix`: round to the context precision and exponent limits (Python's final step of every op). */
  fix(ctx: DecimalContext = current): Decimal {
    const tiny = etiny(ctx);
    const top = etop(ctx);
    if (this.isZero()) {
      const newExp = Math.min(Math.max(this.exp, tiny), ctx.Emax);
      return newExp === this.exp ? this : new Decimal(this.sign, "0", newExp);
    }
    let expMin = this.digits.length + this.exp - ctx.prec;
    if (expMin > top) throw new DecimalError("Overflow", "above Emax");
    if (expMin < tiny) expMin = tiny;
    if (this.exp < expMin) {
      let self: Decimal = this;
      let keep = this.digits.length + this.exp - expMin;
      if (keep < 0) {
        self = new Decimal(this.sign, "1", expMin - 1);
        keep = 0;
      }
      const changed = self.roundingResult(ctx.rounding, keep);
      let coeff = self.digits.slice(0, keep) || "0";
      if (changed > 0) {
        coeff = (BigInt(coeff) + 1n).toString();
        if (coeff.length > ctx.prec) {
          coeff = coeff.slice(0, -1);
          expMin += 1;
        }
      }
      if (expMin > top) throw new DecimalError("Overflow", "above Emax");
      return new Decimal(this.sign, coeff, expMin);
    }
    return this;
  }

  // ------------------------------------------------------------------ arithmetic

  add(other: Decimal, ctx: DecimalContext = current): Decimal {
    let exp = Math.min(this.exp, other.exp);
    const negativeZero: Sign = ctx.rounding === "ROUND_FLOOR" && this.sign !== other.sign ? 1 : 0;
    if (this.isZero() && other.isZero()) {
      let sign: Sign = Math.min(this.sign, other.sign) as Sign;
      if (negativeZero) sign = 1;
      return new Decimal(sign, "0", exp).fix(ctx);
    }
    if (this.isZero()) {
      exp = Math.max(exp, other.exp - ctx.prec - 1);
      return other.rescale(exp, ctx.rounding).fix(ctx);
    }
    if (other.isZero()) {
      exp = Math.max(exp, this.exp - ctx.prec - 1);
      return this.rescale(exp, ctx.rounding).fix(ctx);
    }
    // _normalize: a far smaller operand only matters as a sticky digit
    let [a, b] = [
      { sign: this.sign, int: BigInt(this.digits), exp: this.exp, len: this.digits.length },
      { sign: other.sign, int: BigInt(other.digits), exp: other.exp, len: other.digits.length },
    ];
    {
      const [tmp, oth] = a.exp < b.exp ? [b, a] : [a, b];
      const nexp = tmp.exp + Math.min(-1, tmp.len - ctx.prec - 2);
      if (oth.len + oth.exp - 1 < nexp) {
        oth.int = 1n;
        oth.exp = nexp;
      }
      tmp.int *= 10n ** BigInt(tmp.exp - oth.exp);
      tmp.exp = oth.exp;
    }
    let sign: Sign = 0;
    if (a.sign !== b.sign) {
      if (a.int === b.int) return new Decimal(negativeZero, "0", exp).fix(ctx);
      if (a.int < b.int) [a, b] = [b, a];
      sign = a.sign;
      return new Decimal(sign, (a.int - b.int).toString(), a.exp).fix(ctx);
    }
    sign = a.sign;
    return new Decimal(sign, (a.int + b.int).toString(), a.exp).fix(ctx);
  }

  sub(other: Decimal, ctx: DecimalContext = current): Decimal {
    return this.add(other.copyNegate(), ctx);
  }

  mul(other: Decimal, ctx: DecimalContext = current): Decimal {
    const sign = (this.sign ^ other.sign) as Sign;
    const exp = this.exp + other.exp;
    if (this.isZero() || other.isZero()) return new Decimal(sign, "0", exp).fix(ctx);
    const product = (BigInt(this.digits) * BigInt(other.digits)).toString();
    return new Decimal(sign, product, exp).fix(ctx);
  }

  /** Python `a / b` (true division, correctly rounded, exact results at the ideal exponent). */
  div(other: Decimal, ctx: DecimalContext = current): Decimal {
    const sign = (this.sign ^ other.sign) as Sign;
    if (other.isZero()) {
      if (this.isZero()) throw new DecimalError("InvalidOperation", "0 / 0");
      throw new DecimalError("DivisionByZero", "x / 0");
    }
    let exp: number;
    let coeff: bigint;
    if (this.isZero()) {
      exp = this.exp - other.exp;
      coeff = 0n;
    } else {
      const shift = other.digits.length - this.digits.length + ctx.prec + 1;
      exp = this.exp - other.exp - shift;
      const op1 = BigInt(this.digits);
      const op2 = BigInt(other.digits);
      let remainder: bigint;
      if (shift >= 0) {
        const n = op1 * 10n ** BigInt(shift);
        coeff = n / op2;
        remainder = n % op2;
      } else {
        const dd = op2 * 10n ** BigInt(-shift);
        coeff = op1 / dd;
        remainder = op1 % dd;
      }
      if (remainder !== 0n) {
        if (coeff % 5n === 0n) coeff += 1n;
      } else {
        const ideal = this.exp - other.exp;
        while (exp < ideal && coeff % 10n === 0n) {
          coeff /= 10n;
          exp += 1;
        }
      }
    }
    return new Decimal(sign, coeff.toString(), exp).fix(ctx);
  }

  /** Python `-d` (rounded to the context; `-Decimal("0")` is `0`, not `-0`). */
  neg(ctx: DecimalContext = current): Decimal {
    const ans =
      this.isZero() && ctx.rounding !== "ROUND_FLOOR" ? this.copyAbs() : this.copyNegate();
    return ans.fix(ctx);
  }

  /** Python `+d` (rounded to the context). */
  plus(ctx: DecimalContext = current): Decimal {
    const ans = this.isZero() && ctx.rounding !== "ROUND_FLOOR" ? this.copyAbs() : this;
    return ans.fix(ctx);
  }

  /** Python `abs(d)` (rounded to the context). */
  abs(ctx: DecimalContext = current): Decimal {
    return this.sign ? this.neg(ctx) : this.plus(ctx);
  }

  /** Python `copy_abs()` (exact, no context). */
  copyAbs(): Decimal {
    return this.sign ? new Decimal(0, this.digits, this.exp) : this;
  }

  /** Python `copy_negate()` (exact, no context). */
  copyNegate(): Decimal {
    return new Decimal(this.sign ? 0 : 1, this.digits, this.exp);
  }

  /**
   * Python `d.quantize(Decimal(1).scaleb(exp), rounding)`: `exp` is the quantum's exponent
   * (`-2` for `Decimal("0.01")`); pass a Decimal to use its exponent.
   */
  quantize(quantum: number | Decimal, rounding?: Rounding, ctx: DecimalContext = current): Decimal {
    const exp = typeof quantum === "number" ? quantum : quantum.exp;
    const mode = rounding ?? ctx.rounding;
    if (!(etiny(ctx) <= exp && exp <= ctx.Emax)) {
      throw new DecimalError("InvalidOperation", "target exponent out of bounds in quantize");
    }
    if (this.isZero()) return new Decimal(this.sign, "0", exp).fix(ctx);
    const adjusted = this.adjusted();
    if (adjusted > ctx.Emax) throw new DecimalError("InvalidOperation", "exponent above Emax");
    if (adjusted - exp + 1 > ctx.prec) {
      throw new DecimalError("InvalidOperation", "quantize result has too many digits");
    }
    const ans = this.rescale(exp, mode);
    if (ans.adjusted() > ctx.Emax)
      throw new DecimalError("InvalidOperation", "exponent above Emax");
    if (ans.digits.length > ctx.prec) {
      throw new DecimalError("InvalidOperation", "quantize result has too many digits");
    }
    return ans.fix(ctx);
  }

  /** Python `normalize()`: rounded to the context, trailing zeros stripped (`-0` stays signed). */
  normalize(ctx: DecimalContext = current): Decimal {
    const dup = this.fix(ctx);
    if (dup.isZero()) return new Decimal(dup.sign, "0", 0);
    let end = dup.digits.length;
    let exp = dup.exp;
    while (dup.digits[end - 1] === "0" && exp < ctx.Emax) {
      exp += 1;
      end -= 1;
    }
    return new Decimal(dup.sign, dup.digits.slice(0, end), exp);
  }

  /** Python `scaleb(n)`: exponent shifted by `n`, rounded to the context. */
  scaleb(n: number, ctx: DecimalContext = current): Decimal {
    if (!Number.isSafeInteger(n))
      throw new DecimalError("InvalidOperation", "scaleb needs an integer");
    const lim = 2 * (ctx.Emax + ctx.prec);
    if (n < -lim || n > lim) throw new DecimalError("InvalidOperation", "scaleb out of range");
    return new Decimal(this.sign, this.digits, this.exp + n).fix(ctx);
  }

  /** Python `to_integral_value(rounding)` (no context rounding of the result). */
  toIntegralValue(rounding?: Rounding, ctx: DecimalContext = current): Decimal {
    if (this.exp >= 0) return this;
    if (this.isZero()) return new Decimal(this.sign, "0", 0);
    return this.rescale(0, rounding ?? ctx.rounding);
  }

  /** Python `d ** n` for an integer `n`, emulating libmpdec (`mpd_qpow`, integer branch). */
  pow(n: number | bigint, ctx: DecimalContext = current): Decimal {
    const big = BigInt(n);
    const odd = (big < 0n ? -big : big) % 2n === 1n;
    const resultSign: Sign = this.sign && odd ? 1 : 0;
    if (this.isZero()) {
      if (big === 0n) throw new DecimalError("InvalidOperation", "0 ** 0");
      if (big < 0n) throw new DecimalError("NonFinite", "0 ** negative is Infinity");
      return new Decimal(resultSign, "0", 0);
    }
    if (big === 0n) return new Decimal(0, "1", 0);
    const absN = big < 0n ? -big : big;
    // _qcheck_pow_one: the base is exactly 1
    if (!this.sign && this.exp <= 0 && this.digits === `1${zeros(-this.exp)}`) {
      if (big < 0n) return new Decimal(resultSign, "1", 0).fix(ctx);
      let shift = big * BigInt(-this.exp);
      if (shift > BigInt(ctx.prec - 1)) shift = BigInt(ctx.prec - 1);
      const s = Number(shift);
      return new Decimal(resultSign, `1${zeros(s)}`, -s).fix(ctx);
    }
    // _qcheck_pow_bounds: certain overflow or underflow
    {
      const absX = this.copyAbs();
      const lbTheta = absN.toString().length - 1;
      const t = absX.adjusted();
      let lbZeta: number;
      if (t > 0) lbZeta = digitCount(t) - 1;
      else if (t < -1) lbZeta = digitCount(t + 1) - 1;
      else {
        const u = absX.sub(
          ONE,
          makeContext({ prec: 999_999, Emin: -999_999_999, Emax: 999_999_999 }),
        );
        lbZeta = t === 0 ? u.adjusted() - 2 : u.adjusted() - 1;
      }
      const lessThanOne = t < 0;
      const negativeY = big < 0n;
      if (lessThanOne === negativeY) {
        if (digitCount(ctx.Emax) < lbZeta + lbTheta) {
          throw new DecimalError("Overflow", "power overflows");
        }
      } else if (digitCount(etiny(ctx)) < lbZeta + lbTheta) {
        return new Decimal(resultSign, "1", etiny(ctx) - 1).fix(ctx);
      }
    }
    // _mpd_qpow_int: binary exponentiation in a wider ROUND_HALF_EVEN work context
    let workPrec = ctx.prec + absN.toString().length + 2;
    let base = this.copyAbs();
    if (big < 0n) {
      workPrec += 1;
      base = ONE.div(base, makeContext({ ...ctx, prec: workPrec, rounding: "ROUND_HALF_EVEN" }));
    }
    const work = makeContext({ ...ctx, prec: workPrec, rounding: "ROUND_HALF_EVEN" });
    let result = base;
    let bit = 1n;
    while (bit * 2n <= absN) bit *= 2n;
    try {
      bit >>= 1n;
      while (bit > 0n) {
        result = result.mul(result, work);
        if ((absN & bit) !== 0n) result = result.mul(base, work);
        if (result.isZero()) break;
        bit >>= 1n;
      }
    } catch (error) {
      if (error instanceof DecimalError && error.signal === "Overflow") {
        throw new DecimalError("Overflow", "power overflows");
      }
      throw error;
    }
    return new Decimal(resultSign, result.digits, result.exp).fix(ctx);
  }

  // ------------------------------------------------------------------ formatting

  /**
   * Python `format(d, spec)` for the fixed-point specs the app uses:
   * `[sign][,][.precision]f` (sign one of `+`, `-`, space) and `""` (= `str(d)`). Rounds with the
   * current context's rounding, like Python. Anything else throws.
   */
  format(spec: string, ctx: DecimalContext = current): string {
    if (spec === "") return this.toString();
    const m = /^([ +-])?(,)?(?:\.(\d+))?f$/.exec(spec);
    if (!m) throw new TypeError(`unsupported format spec ${JSON.stringify(spec)}`);
    let d: Decimal = this;
    if (m[3] !== undefined) d = d.rescale(-Number(m[3]), ctx.rounding);
    if (d.isZero() && d.exp > 0) d = d.rescale(0, ctx.rounding);
    const len = d.digits.length;
    const dotplace = d.exp + len;
    let intpart: string;
    let fracpart: string;
    if (dotplace < 0) {
      intpart = "0";
      fracpart = zeros(-dotplace) + d.digits;
    } else if (dotplace > len) {
      intpart = d.digits + zeros(dotplace - len);
      fracpart = "";
    } else {
      intpart = d.digits.slice(0, dotplace) || "0";
      fracpart = d.digits.slice(dotplace);
    }
    const sign = d.sign ? "-" : m[1] === "+" || m[1] === " " ? m[1] : "";
    if (m[2]) intpart = groupThousands(intpart);
    return sign + intpart + (fracpart ? `.${fracpart}` : "");
  }
}

function groupThousands(intpart: string): string {
  const groups: string[] = [];
  for (let end = intpart.length; end > 0; end -= 3)
    groups.unshift(intpart.slice(Math.max(0, end - 3), end));
  return groups.join(",");
}

function invalidLiteral(text: string): DecimalError {
  return new DecimalError("InvalidOperation", `invalid literal ${JSON.stringify(text)}`);
}

export const ZERO: Decimal = Decimal.fromInt(0);
export const ONE: Decimal = Decimal.fromInt(1);

/** Shorthand: `D("1.50")` = `Decimal.parse`, `D(5n)` = `Decimal.fromInt`. */
export function D(value: string | bigint | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  return typeof value === "bigint" ? Decimal.fromInt(value) : Decimal.parse(value);
}

/** Python `sum(values, start)` (left fold with `+` in the current context). */
export function sum(
  values: Iterable<Decimal>,
  start: Decimal = ZERO,
  ctx?: DecimalContext,
): Decimal {
  let total = start;
  for (const v of values) total = total.add(v, ctx ?? current);
  return total;
}

/**
 * `importing/dedup.py:decimal_key`: canonical text of a decimal compared by value (`10.50` -> `10.5`,
 * `1E+1` -> `10`, `-0` -> `0`); empty for null. Exact (no context rounding). gid.md section 3.
 */
export function decimalKey(value: Decimal | null | undefined): string {
  if (value == null) return "";
  let text = value.format("f");
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  if (text === "" || text === "-0" || text === "-") return "0";
  return text;
}

/** Python `format(d, ".2f")` in the default context (half-even, sign kept: `-0.001` -> `-0.00`). */
export function format2(value: Decimal): string {
  return value.format(".2f", DEFAULT_CONTEXT);
}

// ------------------------------------------------------------------ Python floats
// Only for values the Python code keeps as float (ratios, JSON numbers); never for money.

/** Python `repr(x)` / `str(x)` of a float (shortest round-trip digits, Python's layout). */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Number.POSITIVE_INFINITY) return "inf";
  if (x === Number.NEGATIVE_INFINITY) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, expText] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const e = Number(expText);
  const decpt = e + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${zeros(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${zeros(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** Python `format(x, spec)` of a float for the fixed-point specs of `Decimal.format`. */
export function formatFloat(x: number, spec: string): string {
  return Decimal.fromFloat(x).format(spec, DEFAULT_CONTEXT);
}

/** Python `round(x, ndigits)` of a float (half-even on the exact binary value). */
export function roundFloat(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x;
  return Number(Decimal.fromFloat(x).rescale(-ndigits, "ROUND_HALF_EVEN").toString());
}

/** Python `round(x)` of a float: an int, half-even. */
export function roundFloatToInt(x: number): bigint {
  return Decimal.fromFloat(x).rescale(0, "ROUND_HALF_EVEN").toBigInt();
}
