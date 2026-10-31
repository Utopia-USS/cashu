/**
 * Builders for the performance tests: port of the pure half of
 * `tests/investments/performance/perf_support.py` (transactions, instruments, bars, rates). Every
 * value is invented. The DB pipeline household of the Python module (import, fake price / FX
 * sources, strategy file) belongs to the service tests (S19b).
 *
 * Like Python, transactions get ids `t1`, `t2`, ... from a module counter and the default
 * `createdAt` (EPOCH), so same-day ties order by id in Python `str` order.
 */

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
