/**
 * Money and the exact-decimal helpers of `investments/domain/values.py`.
 *
 * Amounts are always `Decimal` (never a JS number); a `Money` carries one currency and refuses to mix
 * two. Net worth is per currency: there is deliberately no cross-currency sum here.
 */

import { type Decimal, type DecimalContext, localContext, makeContext, ZERO } from "./decimal.js";
import { pyStrip, pyUpper } from "./text.js";

/** An ISO 4217 code, three upper-case ASCII letters (`PLN`, `USD`). */
export type Currency = string & { readonly __currency: unique symbol };

export class CurrencyError extends Error {
  constructor(code: string) {
    super(`Not an ISO 4217 currency code: ${JSON.stringify(code)}`);
    this.name = "ValueError";
  }
}

/** `values.Currency(code)`: trimmed, upper-cased, must then be `^[A-Z]{3}$` (ValueError otherwise). */
export function toCurrency(code: string): Currency {
  const normalized = pyUpper(pyStrip(code));
  if (!/^[A-Z]{3}$/.test(normalized)) throw new CurrencyError(code);
  return normalized as Currency;
}

/** `toCurrency` for input that may be anything: null where Python's `Currency(code)` raises. */
export function tryCurrency(code: string): Currency | null {
  const normalized = pyUpper(pyStrip(code));
  return /^[A-Z]{3}$/.test(normalized) ? (normalized as Currency) : null;
}

export class Money {
  readonly amount: Decimal;
  readonly currency: Currency;

  constructor(amount: Decimal, currency: Currency | string) {
    this.amount = amount;
    this.currency = typeof currency === "string" ? toCurrency(currency) : currency;
  }

  static zero(currency: Currency | string): Money {
    return new Money(ZERO, currency);
  }

  private same(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new CurrencyError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
    return other;
  }

  add(other: Money): Money {
    return new Money(this.amount.add(this.same(other).amount), this.currency);
  }

  sub(other: Money): Money {
    return new Money(this.amount.sub(this.same(other).amount), this.currency);
  }

  neg(): Money {
    return new Money(this.amount.neg(), this.currency);
  }

  /** Python `str(Money)`: `"<amount> <currency>"`. */
  toString(): string {
    return `${this.amount.toString()} ${this.currency}`;
  }
}

/** Decimal places kept by `dividedBy` (unit costs, split-adjusted prices, inverse FX rates). */
export const DIVISION_SCALE = 10;

/** `values.EXACT_CONTEXT`: 60 significant digits, ROUND_HALF_UP; the portfolio math runs in it. */
export const EXACT_CONTEXT: DecimalContext = makeContext({ prec: 60, rounding: "ROUND_HALF_UP" });

/** `values.exact_decimals()` / `@exact`: run `fn` in `EXACT_CONTEXT`. */
export function exactDecimals<T>(fn: () => T): T {
  return localContext(EXACT_CONTEXT, fn);
}

const DIVIDE_CONTEXT = makeContext({ prec: 80, rounding: "ROUND_DOWN" });

/**
 * `values.divided_by`: `dividend / divisor` truncated at 80 digits, then rounded half-up to `scale`
 * places. Throws `DecimalError` DivisionByZero / InvalidOperation like Python.
 */
export function dividedBy(
  dividend: Decimal,
  divisor: Decimal,
  scale: number = DIVISION_SCALE,
): Decimal {
  const quotient = dividend.div(divisor, DIVIDE_CONTEXT);
  return quotient.quantize(-scale, "ROUND_HALF_UP", DIVIDE_CONTEXT);
}

const RATIO_CONTEXT = makeContext({ prec: 40 });

/** `values.ratio`: `part / total` as a float (Python float), null when part is null or total is 0. */
export function ratio(part: Decimal | null | undefined, total: Decimal): number | null {
  if (part == null || total.isZero()) return null;
  return part.div(total, RATIO_CONTEXT).toFloat();
}
