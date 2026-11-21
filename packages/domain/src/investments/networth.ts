/**
 * Investments' net-worth contributor (`modules/investments/networth.py`): a brokerage account is
 * worth its holdings plus its broker cash, valued by `valuePortfolio` in the account's currency (NBP
 * rates for other currencies, stored prices, the last trade price as the fallback). Net worth stays
 * per currency: the value is reported in the account currency like any other account.
 *
 * History: the value is computed exactly at month ends (and today) and held flat in between. A
 * brokerage account without investments transactions is left to the core (its balance snapshots).
 *
 * Python loads the profile's history through the session; here the caller (the store, or a parity
 * producer) hands over the loaded rows (`BrokerageHistory`) and the contributor only picks windows of
 * them the way the Python queries do.
 */

import {
  BROKERAGE,
  type NetWorthAccount,
  type NetWorthContributor,
  type Valuation,
} from "../core/index.js";
import { addDays, daysInMonth, formatDate, type IsoDate, parseDate } from "../dates.js";
import type { Decimal } from "../decimal.js";
import type { Instrument, InstrumentRename, ManualValuation } from "./domain/instrument.js";
import type { FxRate, PriceBar } from "./domain/marketData.js";
import { marketView } from "./domain/snapshot.js";
import type { Transaction } from "./domain/transaction.js";
import {
  type AccountId,
  asAccountId,
  type Currency,
  type InstrumentId,
  type ProfileId,
  toCurrency,
} from "./domain/values.js";
import { fxCurrenciesFor, InMemoryFxLookup, preloadRates } from "./portfolio/fxLookup.js";
import { buildSnapshot } from "./portfolio/snapshotBuilder.js";
import { valuePortfolio } from "./portfolio/valuation.js";

/** `DataQualityPolicy().max_price_age_days`: net worth uses the default policy. */
const MAX_PRICE_AGE_DAYS = 5;
/**
 * Net worth uses the newest known NBP rate up to a year old (the rules' 10-day limit would drop
 * foreign holdings from net worth whenever the daily check has not run for a while).
 */
export const NETWORTH_MAX_FX_AGE_DAYS = 366;
/** Bars loaded for "now" (the newest one is used). */
const LATEST_WINDOW_DAYS = 400;

/** One profile's investments rows, loaded once (Python `_ProfileHistory`). */
export interface BrokerageHistory {
  readonly profileId: ProfileId;
  /** The profile's transactions (every brokerage account). */
  readonly txns: readonly Transaction[];
  readonly renames: readonly InstrumentRename[];
  /** Instruments referenced by the transactions and renames, as the profile sees them. */
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  /** The profile's manual valuations of those instruments, oldest first. */
  readonly manualValuations: readonly ManualValuation[];
  /** Every stored bar of those instruments, oldest first per instrument (any date). */
  readonly bars: readonly PriceBar[];
  /** Every stored FX rate, oldest first per pair (any date). */
  readonly rates: readonly FxRate[];
}

/** Last day of every month from `start`'s month up to `end` (exclusive of a month end >= `end`). */
export function monthEnds(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let { year, month } = parseDate(start);
  for (;;) {
    const last = formatDate({ year, month, day: daysInMonth(year, month) });
    if (last >= end) break;
    out.push(last);
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }
  return out;
}

const byDate =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

class ProfileHistory {
  readonly history: BrokerageHistory;
  private readonly today: IsoDate;
  private readonly accountCurrencies: ReadonlySet<string>;
  private full: { bars: Map<InstrumentId, PriceBar[]>; fx: InMemoryFxLookup } | null = null;

  constructor(history: BrokerageHistory, today: IsoDate, accountCurrencies: ReadonlySet<string>) {
    this.history = history;
    this.today = today;
    this.accountCurrencies = accountCurrencies;
  }

  /** `_ProfileHistory.currencies`. */
  private currencies(): Set<Currency> {
    const out = new Set<Currency>();
    for (const t of this.history.txns) {
      out.add(t.currency);
      out.add(t.cashCurrency);
    }
    for (const i of this.history.instruments.values()) out.add(i.currency);
    for (const v of this.history.manualValuations) out.add(v.currency);
    return out;
  }

  /** `full_market`: every bar up to today, every needed rate up to today (for the series). */
  private fullMarket(): { bars: Map<InstrumentId, PriceBar[]>; fx: InMemoryFxLookup } {
    if (this.full !== null) return this.full;
    const bars = new Map<InstrumentId, PriceBar[]>();
    for (const bar of this.history.bars) {
      if (!this.history.instruments.has(bar.instrumentId) || bar.date > this.today) continue;
      const list = bars.get(bar.instrumentId) ?? [];
      list.push(bar);
      bars.set(bar.instrumentId, list);
    }
    const currencies = new Set([
      ...this.currencies(),
      ...[...this.accountCurrencies].map(toCurrency),
    ]);
    // InMemoryMarketData keeps the PLN rates by quote then date (the last stored one wins).
    const rates = preloadRates(this.history.rates, currencies, this.today, null);
    this.full = { bars, fx: new InMemoryFxLookup(rates) };
    return this.full;
  }

  private valuationsFor(held: ReadonlySet<InstrumentId>): Map<InstrumentId, ManualValuation[]> {
    const grouped = new Map<InstrumentId, ManualValuation[]>();
    for (const v of this.history.manualValuations) {
      if (!held.has(v.instrumentId)) continue;
      const list = grouped.get(v.instrumentId) ?? [];
      list.push(v);
      grouped.set(v.instrumentId, list);
    }
    for (const list of grouped.values()) list.sort(byDate<ManualValuation>((m) => m.asOf));
    return grouped;
  }

  /** Holdings + cash of `accountId` as of `on` in `currency` (null before its first transaction). */
  value(
    accountId: AccountId,
    currency: Currency,
    on: IsoDate,
    recentOnly: boolean,
  ): Decimal | null {
    const mine = this.history.txns.filter((t) => t.accountId === accountId && t.tradeDate <= on);
    if (mine.length === 0) return null;
    const snapshot = buildSnapshot(this.history.profileId, mine, on, {
      renames: this.history.renames,
    });
    const held = new Set(snapshot.holdings.map((h) => h.instrumentId));
    const listed = new Map([...this.history.instruments].filter(([id]) => held.has(id)));
    let view: ReturnType<typeof marketView>;
    let fx: InMemoryFxLookup;
    if (recentOnly) {
      const since = addDays(on, -LATEST_WINDOW_DAYS);
      const bars = new Map<InstrumentId, PriceBar[]>();
      for (const bar of this.history.bars) {
        if (!held.has(bar.instrumentId) || bar.date > on || bar.date < since) continue;
        const list = bars.get(bar.instrumentId) ?? [];
        list.push(bar);
        bars.set(bar.instrumentId, list);
      }
      view = marketView({
        asOf: on,
        instruments: listed,
        bars,
        manualValuations: this.valuationsFor(held),
      });
      const needs = fxCurrenciesFor(snapshot, view, currency);
      fx = new InMemoryFxLookup(
        preloadRates(this.history.rates, needs.currencies, snapshot.asOf, needs.oldest),
      );
    } else {
      const store = this.fullMarket();
      const bars = new Map<InstrumentId, PriceBar[]>();
      for (const [id, series] of store.bars) {
        if (listed.has(id))
          bars.set(
            id,
            series.filter((b) => b.date <= on),
          );
      }
      view = marketView({
        asOf: on,
        instruments: listed,
        bars,
        manualValuations: this.valuationsFor(held),
      });
      fx = store.fx;
    }
    return valuePortfolio(snapshot, view, fx, currency, MAX_PRICE_AGE_DAYS, {
      maxFxAgeDays: NETWORTH_MAX_FX_AGE_DAYS,
    }).totalBase;
  }
}

/** `BrokerageValuation`: the core `Valuation` of one brokerage account. */
class BrokerageValuation implements Valuation {
  private readonly history: ProfileHistory;
  private readonly accountId: AccountId;
  private readonly currency: Currency;
  private readonly today: IsoDate;
  private readonly first: IsoDate | null;
  private readonly memo = new Map<IsoDate, Decimal | null>();

  constructor(history: ProfileHistory, accountId: AccountId, currency: Currency, today: IsoDate) {
    this.history = history;
    this.accountId = accountId;
    this.currency = currency;
    this.today = today;
    let first: IsoDate | null = null;
    for (const t of history.history.txns) {
      if (t.accountId === accountId && (first === null || t.tradeDate < first)) first = t.tradeDate;
    }
    this.first = first;
  }

  latest(asOf: IsoDate | null, today: IsoDate): readonly [IsoDate, Decimal] | null {
    const ref = asOf ?? today;
    const value = this.history.value(this.accountId, this.currency, ref, true);
    return value === null ? null : [ref, value];
  }

  axisDates(): IsoDate[] {
    if (this.first === null || this.first > this.today) return [];
    return [...monthEnds(this.first, this.today), this.today];
  }

  at(d: IsoDate): Decimal | null {
    if (this.first === null || d < this.first) return null;
    const points = this.axisDates().filter((p) => p <= d);
    const point = points[points.length - 1] ?? d;
    if (!this.memo.has(point)) {
      this.memo.set(point, this.history.value(this.accountId, this.currency, point, false));
    }
    return this.memo.get(point) ?? null;
  }
}

/**
 * `InvestmentsContributor`: values the profile's brokerage accounts that have investments
 * transactions. `accountId` maps a net-worth account id to the transactions' account id (identity
 * when both are the same gid; parity maps natural keys to the app's ids).
 */
export class BrokerageContributor implements NetWorthContributor {
  private readonly history: BrokerageHistory;
  private readonly today: IsoDate;
  private readonly accountId: (netWorthAccountId: string) => AccountId;

  constructor(
    history: BrokerageHistory,
    today: IsoDate,
    accountId: (netWorthAccountId: string) => AccountId = asAccountId,
  ) {
    this.history = history;
    this.today = today;
    this.accountId = accountId;
  }

  valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
    const brokerage = [...accounts.values()].filter((a) => a.type === BROKERAGE);
    const withTxns = new Set(this.history.txns.map((t) => t.accountId));
    const out = new Map<string, Valuation>();
    if (brokerage.length === 0) return out;
    const shared = new ProfileHistory(
      this.history,
      this.today,
      new Set(brokerage.map((a) => a.currency)),
    );
    for (const account of brokerage) {
      const id = this.accountId(account.id);
      if (!withTxns.has(id)) continue;
      out.set(
        account.id,
        new BrokerageValuation(shared, id, toCurrency(account.currency), this.today),
      );
    }
    return out;
  }
}
