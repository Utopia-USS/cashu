/**
 * Builders and float assertions for the performance tests (transactions, instruments, bars, rates).
 * Every value is invented. Transactions get ids `t1`, `t2`, ... from a module counter and the default
 * `createdAt` (EPOCH), so same-day ties order by id in `str` order.
 */

import { expect } from "vitest";
import { addDays, daysBetween } from "../../../dates.js";
import { D, type Decimal, floatRepr } from "../../../decimal.js";
import { AssetClass, parseTxnType } from "../../domain/enums.js";
import { type Instrument, instrument as makeInstrument } from "../../domain/instrument.js";
import { type FxRate, fxRate, type PriceBar, priceBar } from "../../domain/marketData.js";
import { type Transaction, transaction } from "../../domain/transaction.js";
import {
  asAccountId,
  asInstrumentId,
  asTxnId,
  type CalendarDate,
  Currencies,
  type Currency,
} from "../../domain/values.js";

export const PLN = Currencies.PLN;
export const EUR = Currencies.EUR;
export const USD = Currencies.USD;

/** `day("2025-01-02")`: the ISO date itself (dates are ISO strings in TS). */
export const day = (text: string): CalendarDate => text;

/** Every day from `start` to `end`, both included. */
export function days(start: string, end: string): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let i = 0; i <= daysBetween(start, end); i++) out.push(addDays(start, i));
  return out;
}

let seq = 0;

export interface TxnOptions {
  readonly account?: string;
  readonly instrument?: string | null;
  readonly quantity?: string | null;
  readonly price?: string | null;
  readonly currency?: Currency;
  readonly cashCurrency?: Currency | null;
  readonly gross?: string | null;
  readonly fee?: string;
  readonly ratio?: string | null;
  readonly tid?: string | null;
}

/** `txn(kind, when, cash, ...)`: gross defaults to |quantity * price| (0 without both). */
export function txn(
  kind: string,
  when: string,
  cash: string | Decimal = "0",
  options: TxnOptions = {},
): Transaction {
  const q = options.quantity == null ? null : D(options.quantity);
  const p = options.price == null ? null : D(options.price);
  const g = options.gross != null ? D(options.gross) : q !== null && p !== null ? q.mul(p) : D("0");
  const currency = options.currency ?? PLN;
  seq += 1;
  return transaction({
    id: asTxnId(options.tid ?? `t${seq}`),
    accountId: asAccountId(options.account ?? "1"),
    type: parseTxnType(kind),
    tradeDate: when,
    currency,
    grossAmount: g.abs(),
    cashAmount: typeof cash === "string" ? D(cash) : cash,
    cashCurrency: options.cashCurrency ?? currency,
    instrumentId: options.instrument == null ? null : asInstrumentId(options.instrument),
    quantity: q,
    price: p,
    fee: D(options.fee ?? "0"),
    splitRatio: options.ratio == null ? null : D(options.ratio),
  });
}

/** `instrument(iid, currency, asset_class, tags=...)` named `Instrument <iid>`. */
export function instrument(
  iid: string,
  currency: Currency = PLN,
  assetClass: AssetClass = AssetClass.ETF,
  options: { readonly tags?: readonly string[] } = {},
): Instrument {
  return makeInstrument({
    id: asInstrumentId(iid),
    name: `Instrument ${iid}`,
    currency,
    assetClass,
    tags: options.tags ?? [],
  });
}

/** Python `str(v)` of a close given as text or float (`105.0` -> `"105.0"`). */
function closeText(value: string | number): string {
  return typeof value === "string" ? value : floatRepr(value);
}

/** Bars from `{date: close}`, oldest first. */
export function bars(iid: string, closes: Readonly<Record<string, string | number>>): PriceBar[] {
  return Object.keys(closes)
    .sort()
    .map((k) =>
      priceBar({
        instrumentId: asInstrumentId(iid),
        date: k,
        close: D(closeText(closes[k] as string | number)),
        source: "test",
      }),
    );
}

/** FX rates of `quote` (PLN per unit) from `{date: rate}`, in the given order. */
export function rates(quote: Currency, values: Readonly<Record<string, string>>): FxRate[] {
  return Object.entries(values).map(([k, v]) =>
    fxRate({ quote, date: k, rate: D(v), source: "test" }),
  );
}

export interface Tolerance {
  readonly rel?: number;
  readonly abs?: number;
}

/** Approximate float equality (rel 1e-6, abs 1e-12 by default; abs alone when only abs is given). */
export function approxEq(
  actual: number | null | undefined,
  expected: number,
  tol: Tolerance = {},
): boolean {
  if (actual == null) return false;
  if (actual === expected) return true;
  const limit =
    tol.abs !== undefined && tol.rel === undefined
      ? tol.abs
      : Math.max((tol.rel ?? 1e-6) * Math.abs(expected), tol.abs ?? 1e-12);
  return Math.abs(actual - expected) <= limit;
}

export function expectApprox(
  actual: number | null | undefined,
  expected: number,
  tol: Tolerance = {},
): void {
  expect(approxEq(actual, expected, tol), `${actual} ~ ${expected}`).toBe(true);
}

export function expectApproxList(
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
  tol: Tolerance = {},
): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i] as number | null;
    if (e === null) expect(a).toBeNull();
    else expectApprox(a, e, tol);
  });
}

/** IEEE float equality (`-0.0 == 0.0`, unlike `toBe`). */
export function expectFloatEq(actual: number | null | undefined, expected: number): void {
  expect(actual === expected, `${actual} == ${expected}`).toBe(true);
}
