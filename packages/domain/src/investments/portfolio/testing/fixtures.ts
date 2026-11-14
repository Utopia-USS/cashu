/**
 * Transaction, bar and FX builders for the portfolio math tests (synthetic, hand-computable numbers):
 * port of `tests/investments/portfolio/inv_portfolio_fixtures.py`.
 *
 * Every builder takes the next value of a shared counter as `createdAt`, so transactions on the same
 * day keep the order in which a test creates them (the lot engine sorts by trade date, then
 * `createdAt`).
 */

import { addDays, type DateTime } from "../../../dates.js";
import { type Decimal, D as parseD, ZERO } from "../../../decimal.js";
import type { ValuationMode } from "../../domain/enums.js";
import { AssetClass, InstrumentStatus, TxnSource, TxnType } from "../../domain/enums.js";
import {
  type Instrument,
  type InstrumentAlias,
  type ManualValuation,
  instrument as makeInstrument,
  manualValuation,
} from "../../domain/instrument.js";
import {
  type FxRate,
  fxRate as makeFxRate,
  type PriceBar,
  priceBar,
} from "../../domain/marketData.js";
import { type MarketView, marketView as makeMarketView } from "../../domain/snapshot.js";
import { type Transaction, transaction } from "../../domain/transaction.js";
import {
  type AccountId,
  asAccountId,
  asInstrumentId,
  asTxnId,
  Currencies,
  type Currency,
  type InstrumentId,
} from "../../domain/values.js";

export const PLN = Currencies.PLN;
export const USD = Currencies.USD;
export const EUR = Currencies.EUR;
export const GBP = Currencies.GBP;

let sequence = 0;

/** `Decimal(str(value))`. */
export function d(value: string | number): Decimal {
  return parseD(String(value));
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** 2026-01-01T00:00:00+00:00 plus the next counter value in seconds. */
function nextCreatedAt(): DateTime {
  sequence += 1;
  const days = Math.floor(sequence / 86400);
  const rest = sequence % 86400;
  return {
    date: addDays("2026-01-01", days),
    hour: Math.floor(rest / 3600),
    minute: Math.floor((rest % 3600) / 60),
    second: rest % 60,
    microsecond: 0,
    offsetSeconds: 0,
  };
}

export interface TxnInit {
  readonly txnId?: string;
  readonly type?: TxnType;
  readonly tradeDate?: string;
  /** `null` = no quantity (Python `quantity=None`); default "10". */
  readonly quantity?: string | null;
  /** `null` = no price; default "100". */
  readonly price?: string | null;
  readonly currency?: Currency;
  readonly grossAmount?: string | null;
  readonly fee?: string;
  readonly tax?: string;
  readonly cashAmount?: string | null;
  readonly cashCurrency?: Currency | null;
  readonly source?: TxnSource;
  readonly splitRatio?: string | null;
  readonly fxRate?: string | null;
  readonly createdAt?: DateTime | null;
}

/** A buy of `quantity` at `price` by default; override `type` and amounts for other events. */
export function buildTxn(
  accountId: string,
  instrumentId: string | null = null,
  init: TxnInit = {},
): Transaction {
  const quantity = init.quantity === undefined ? "10" : init.quantity;
  const price = init.price === undefined ? "100" : init.price;
  const fee = d(init.fee ?? "0");
  let gross: Decimal;
  if (init.grossAmount != null) gross = d(init.grossAmount);
  else if (quantity !== null && price !== null) gross = d(quantity).mul(d(price));
  else gross = ZERO;
  const currency = init.currency ?? PLN;
  return transaction({
    id: asTxnId(init.txnId ?? newId()),
    accountId: asAccountId(accountId),
    instrumentId: instrumentId === null ? null : asInstrumentId(instrumentId),
    type: init.type ?? TxnType.BUY,
    tradeDate: init.tradeDate ?? "2026-01-05",
    quantity: quantity === null ? null : d(quantity),
    price: price === null ? null : d(price),
    currency,
    grossAmount: gross,
    fee,
    tax: d(init.tax ?? "0"),
    cashAmount: init.cashAmount != null ? d(init.cashAmount) : gross.add(fee).neg(),
    cashCurrency: init.cashCurrency ?? currency,
    source: init.source ?? TxnSource.IMPORT,
    splitRatio: init.splitRatio == null ? null : d(init.splitRatio),
    fxRate: init.fxRate == null ? null : d(init.fxRate),
    createdAt: init.createdAt ?? nextCreatedAt(),
  });
}

interface TradeOptions {
  readonly fee?: string;
  readonly tax?: string;
  readonly currency?: Currency;
}

export function buy(
  account: string,
  instrumentId: string,
  tradeDate: string,
  quantity: string,
  price: string,
  { fee = "0", tax = "0", currency = PLN }: TradeOptions = {},
): Transaction {
  const gross = d(quantity).mul(d(price));
  return buildTxn(account, instrumentId, {
    tradeDate,
    quantity,
    price,
    fee,
    tax,
    currency,
    cashAmount: gross.add(d(fee)).add(d(tax)).neg().toString(),
  });
}

export function sell(
  account: string,
  instrumentId: string,
  tradeDate: string,
  quantity: string,
  price: string,
  { fee = "0", tax = "0", currency = PLN }: TradeOptions = {},
): Transaction {
  const gross = d(quantity).mul(d(price));
  return buildTxn(account, instrumentId, {
    type: TxnType.SELL,
    tradeDate,
    quantity,
    price,
    fee,
    tax,
    currency,
    cashAmount: gross.sub(d(fee)).sub(d(tax)).toString(),
  });
}

export function split(
  account: string,
  instrumentId: string,
  tradeDate: string,
  ratio: string,
): Transaction {
  return buildTxn(account, instrumentId, {
    type: TxnType.SPLIT,
    tradeDate,
    quantity: null,
    price: null,
    cashAmount: "0",
    splitRatio: ratio,
  });
}

export function transferIn(
  account: string,
  instrumentId: string,
  tradeDate: string,
  quantity: string,
  { price = null }: { readonly price?: string | null } = {},
): Transaction {
  return buildTxn(account, instrumentId, {
    type: TxnType.TRANSFER_IN,
    tradeDate,
    quantity,
    price,
    grossAmount: "0",
    cashAmount: "0",
  });
}

export function transferOut(
  account: string,
  instrumentId: string,
  tradeDate: string,
  quantity: string,
): Transaction {
  return buildTxn(account, instrumentId, {
    type: TxnType.TRANSFER_OUT,
    tradeDate,
    quantity,
    price: null,
    grossAmount: "0",
    cashAmount: "0",
  });
}

export function cashTxn(
  account: string,
  tradeDate: string,
  amount: string,
  {
    type = TxnType.DEPOSIT,
    currency = PLN,
  }: { readonly type?: TxnType; readonly currency?: Currency } = {},
): Transaction {
  return buildTxn(account, null, {
    type,
    tradeDate,
    quantity: null,
    price: null,
    currency,
    grossAmount: d(amount).copyAbs().toString(),
    cashAmount: amount,
  });
}

export interface InstrumentFixture {
  readonly name?: string;
  readonly symbol?: string | null;
  readonly mic?: string | null;
  readonly currency?: Currency;
  readonly assetClass?: AssetClass;
  readonly tags?: Iterable<string>;
  readonly needsClassification?: boolean;
  readonly aliases?: Iterable<InstrumentAlias>;
  readonly valuationMode?: ValuationMode | null;
  readonly status?: InstrumentStatus;
}

export function instrument(
  instrumentId: string | null = null,
  init: InstrumentFixture = {},
): Instrument {
  return makeInstrument({
    id: asInstrumentId(instrumentId ?? newId()),
    name: init.name ?? "Orlen",
    symbol: init.symbol === undefined ? "PKN" : init.symbol,
    mic: init.mic === undefined ? "XWAR" : init.mic,
    currency: init.currency ?? PLN,
    assetClass: init.assetClass ?? AssetClass.EQUITY,
    tags: init.tags ?? [],
    needsClassification: init.needsClassification ?? false,
    aliases: init.aliases ?? [],
    ...(init.valuationMode != null ? { valuationMode: init.valuationMode } : {}),
    status: init.status ?? InstrumentStatus.ACTIVE,
  });
}

const FETCHED_AT: DateTime = Object.freeze({
  date: "2026-01-01",
  hour: 0,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
});

export function bar(instrumentId: string, on: string, close: string): PriceBar {
  return priceBar({
    instrumentId: asInstrumentId(instrumentId),
    date: on,
    close: d(close),
    source: "test",
    fetchedAt: FETCHED_AT,
  });
}

export function fxRate(
  quote: Currency,
  on: string,
  rate: string,
  { base = PLN }: { readonly base?: Currency } = {},
): FxRate {
  return makeFxRate({
    quote,
    base,
    date: on,
    rate: d(rate),
    source: "test",
    fetchedAt: FETCHED_AT,
  });
}

export function manual(
  instrumentId: string,
  on: string,
  unitValue: string,
  currency: Currency = PLN,
): ManualValuation {
  return manualValuation({
    instrumentId: asInstrumentId(instrumentId),
    asOf: on,
    unitValue: d(unitValue),
    currency,
  });
}

/** A market view with `instruments`, their `bars` and manual valuations (grouped, sorted). */
export function marketView(
  asOf: string,
  {
    instruments = [],
    bars = [],
    manualValuations = [],
  }: {
    readonly instruments?: Iterable<Instrument>;
    readonly bars?: Iterable<PriceBar>;
    readonly manualValuations?: Iterable<ManualValuation>;
  } = {},
): MarketView {
  const byInstrument = new Map<InstrumentId, PriceBar[]>();
  for (const item of bars) {
    const list = byInstrument.get(item.instrumentId) ?? [];
    list.push(item);
    byInstrument.set(item.instrumentId, list);
  }
  const byValuation = new Map<InstrumentId, ManualValuation[]>();
  for (const item of manualValuations) {
    const list = byValuation.get(item.instrumentId) ?? [];
    list.push(item);
    byValuation.set(item.instrumentId, list);
  }
  const byDate =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return makeMarketView({
    asOf,
    instruments: new Map([...instruments].map((i) => [i.id, i] as const)),
    bars: new Map(
      [...byInstrument].map(([k, v]) => [k, v.sort(byDate<PriceBar>((b) => b.date))] as const),
    ),
    manualValuations: new Map(
      [...byValuation].map(
        ([k, v]) => [k, v.sort(byDate<ManualValuation>((m) => m.asOf))] as const,
      ),
    ),
  });
}

/** Brand a test account id. */
export const acc = (id: string): AccountId => asAccountId(id);
/** Brand a test instrument id. */
export const ins = (id: string): InstrumentId => asInstrumentId(id);
