/**
 * Value types of the investments domain (`investments/domain/values.py`): ids, calendar dates,
 * currencies, money and exact decimals.
 *
 * Ids are branded strings (UUIDs today, global ids later); a bare `string` does not type-check where an
 * id is meant. Money and the exact-decimal helpers are the shared primitives of `money.ts`, re-exported
 * here so the investments domain reads like the Python package.
 */

import { type DateTime, daysBetween, type IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import {
  type Currency,
  DIVISION_SCALE,
  dividedBy,
  EXACT_CONTEXT,
  exactDecimals,
  Money,
  ratio,
  toCurrency,
} from "../../money.js";

export type { Currency };
/** `values.days_between`: whole days from `start` to `end` (positive when `end` is later). */
export {
  DIVISION_SCALE,
  daysBetween,
  dividedBy,
  EXACT_CONTEXT,
  exactDecimals,
  Money,
  ratio,
  toCurrency,
};

/** A nominal type: `Brand<string, "AccountId">` is a string that only `asAccountId` produces. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProfileId = Brand<string, "ProfileId">;
export type AccountId = Brand<string, "AccountId">;
export type InstrumentId = Brand<string, "InstrumentId">;
export type TxnId = Brand<string, "TxnId">;
export type ImportBatchId = Brand<string, "ImportBatchId">;

/** Brand a persistence key as a profile id (the store's gid functions call these). */
export const asProfileId = (value: string): ProfileId => value as ProfileId;
export const asAccountId = (value: string): AccountId => value as AccountId;
export const asInstrumentId = (value: string): InstrumentId => value as InstrumentId;
export const asTxnId = (value: string): TxnId => value as TxnId;
export const asImportBatchId = (value: string): ImportBatchId => value as ImportBatchId;

/** A calendar date (no time, no zone) as ISO `YYYY-MM-DD`; string order is date order. */
export type CalendarDate = IsoDate;

/** A broken invariant of a domain value (Python raises `ValueError`). */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/** Neutral timestamp where a source or test does not care (ordering ties fall back to the id). */
export const EPOCH: DateTime = Object.freeze({
  date: "1970-01-01",
  hour: 0,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
});

/** `Currency.PLN`, `Currency.USD`, ...: the codes the Python class carries as attributes. */
export const Currencies = Object.freeze({
  PLN: toCurrency("PLN"),
  EUR: toCurrency("EUR"),
  USD: toCurrency("USD"),
  GBP: toCurrency("GBP"),
  CHF: toCurrency("CHF"),
});

/** Python `Money.__eq__`: same currency and the same amount by value (`11.00 PLN == 11 PLN`). */
export function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount.eq(b.amount);
}

/** `@exact`: wrap `fn` so it runs in `EXACT_CONTEXT`. */
export function exact<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => exactDecimals(() => fn(...args));
}

/** Python `str` ordering (by code point, not UTF-16 unit) for ids and other keys. */
export function comparePyStr(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = (left[i] as string).codePointAt(0) as number;
    const y = (right[i] as string).codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

/** Optional fields of `T` named by `K`: the input of a factory that fills Python's defaults. */
export type Init<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Decimal or null, the shape of every optional money field. */
export type MaybeDecimal = Decimal | null;

/**
 * Python dataclass defaults: `defaults` overlaid with every field of `init` that is not undefined,
 * frozen (shallow). An explicit `undefined` keeps the default, like an omitted keyword argument.
 */
export function withDefaults<T extends object>(defaults: Partial<T>, init: Partial<T>): T {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(init)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.freeze(out) as T;
}
