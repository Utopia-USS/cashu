/** Instruments, bars and dates for the pure market tests (`tests/investments/market/inv_market_support.py`). */

import { addDays, type DateTime, weekday } from "../../../dates.js";
import { D, type Decimal } from "../../../decimal.js";
import { AssetClass } from "../../domain/enums.js";
import {
  type Instrument,
  type InstrumentAlias,
  type InstrumentInit,
  instrument,
  instrumentAlias,
} from "../../domain/instrument.js";
import { type PriceBar, priceBar } from "../../domain/marketData.js";
import { asInstrumentId, Currencies } from "../../domain/values.js";

/** Fetch time the sources stamp on bars and rates in tests. */
export const FETCHED_AT: DateTime = Object.freeze({
  date: "2026-10-04",
  hour: 18,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
});

export const d = (value: string | number): Decimal => D(String(value));

let counter = 0;

export function buildInstrument(
  init: Partial<Omit<InstrumentInit, "aliases">> & {
    readonly aliases?: Iterable<InstrumentAlias>;
  } = {},
): Instrument {
  counter += 1;
  return instrument({
    id: asInstrumentId(`instrument-${counter}`),
    name: "Orlen",
    symbol: "PKN",
    mic: "XWAR",
    currency: Currencies.PLN,
    assetClass: AssetClass.EQUITY,
    ...init,
  });
}

/** Orlen on GPW (XWAR) with confirmed stooq and yahoo aliases. */
export function orlen(aliases?: readonly InstrumentAlias[]): Instrument {
  return buildInstrument({
    aliases: aliases ?? [instrumentAlias("stooq", "pkn"), instrumentAlias("yahoo", "PKN.WA")],
  });
}

/** Vanguard FTSE All-World on XETRA with confirmed yahoo and stooq aliases. */
export function vwce(aliases?: readonly InstrumentAlias[]): Instrument {
  return buildInstrument({
    name: "Vanguard FTSE All-World",
    symbol: "VWCE",
    mic: "XETR",
    currency: Currencies.EUR,
    assetClass: AssetClass.ETF,
    aliases: aliases ?? [instrumentAlias("yahoo", "VWCE.DE"), instrumentAlias("stooq", "vwce.de")],
  });
}

export function weekdays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    if (weekday(current) < 5) days.push(current);
  }
  return days;
}

/** One bar per weekday of `start..end`. */
export function weekdayBars(
  target: Instrument,
  start: string,
  end: string,
  options: {
    readonly close?: string;
    readonly fetchedAt?: DateTime | null;
    readonly source?: string;
  } = {},
): PriceBar[] {
  return weekdays(start, end).map((on) =>
    priceBar({
      instrumentId: target.id,
      date: on,
      close: d(options.close ?? "10"),
      source: options.source ?? "yahoo",
      fetchedAt: options.fetchedAt === undefined ? FETCHED_AT : options.fetchedAt,
    }),
  );
}
