// What one vault's performance is computed from (Python `performance/service.load`): the vault's
// transactions, renames, instruments as this profile sees them, manual valuations and brokerage
// accounts from the view, plus the closes and PLN rates from the device's price cache (device-local,
// never in the view: events.md 10). The strategy values come from the caller (the strategy loader).
import { addDays } from "@cashu/domain";
import {
  AliasNamespace,
  type Currency,
  InMemoryFxLookup,
  type Instrument,
  type InstrumentId,
  type ManualValuation,
  type market,
  type PriceBar,
  preloadRates,
  type Transaction,
  toCurrency,
} from "@cashu/domain/investments";
import * as perf from "@cashu/domain/investments/performance";
import { profileOf } from "../../core/queries.js";
import { type MarketInput, resolveMarketInput } from "../marketInput.js";
import { instrumentByAlias, instrumentByIsin, loadInstruments } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import {
  brokerageAccounts,
  manualValuations,
  renames as renamesOf,
  transactions,
} from "../queries/transactions.js";

/** Python `str.strip` / `upper` / `lower` on a proxy symbol (ASCII market symbols). */
const variants = (value: string): string[] => [
  ...new Set([value, value.toUpperCase(), value.toLowerCase()]),
];

/**
 * Python `service.find_proxy`: the instrument (gid) a strategy `benchmark.proxy` names: by ISIN, else
 * by its yahoo alias (a guessed alias counts; as written, upper or lower case), else by a stooq alias.
 */
export function findProxy(read: Read, proxy: string): Instrument | undefined {
  const value = proxy.trim();
  if (value === "") return undefined;
  if (perf.isIsin(value)) {
    const found = instrumentByIsin(read, value);
    if (found !== undefined) return found;
  }
  for (const namespace of [AliasNamespace.YAHOO, AliasNamespace.STOOQ]) {
    for (const variant of variants(value)) {
      const found = instrumentByAlias(read, namespace, variant);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export type InputsRequest = MarketInput & {
  /** The last day of the history (the service's `end`, today by default in the app). */
  readonly asOf: string;
  readonly strategy: perf.PerformanceStrategy;
  /** Provider preference for a tie in the cache (default: the domain's source order). */
  readonly order?: market.PriceSourceOrder;
};

/** Python `service.load(session, profile, end)` over this vault's view and the price cache. */
export function performanceInputs(read: Read, request: InputsRequest): perf.PerformanceInputs {
  const { asOf: end, strategy } = request;
  const profile = profileOf(read);
  const base = perf.baseCurrencyOf(
    profile === undefined ? null : toCurrency(profile.baseCurrency),
    strategy,
  );
  const txns = transactions(read).filter((t) => t.tradeDate <= end);
  const renames = renamesOf(read);
  const referenced = new Set<InstrumentId>();
  for (const t of txns) if (t.instrumentId !== null) referenced.add(t.instrumentId);
  for (const r of renames) {
    referenced.add(r.oldInstrumentId);
    referenced.add(r.newInstrumentId);
  }
  const benchmark = strategy.strategy === null ? null : strategy.benchmark;
  const proxyId = benchmark === null ? undefined : findProxy(read, benchmark.proxy)?.id;
  const ids = new Set(referenced);
  if (proxyId !== undefined) ids.add(proxyId);
  // the profile's own view (valuation mode, status incl. frozen, classification overrides)
  const instruments = new Map<InstrumentId, Instrument>();
  for (const i of loadInstruments(read, ids).values()) instruments.set(i.id, i);

  let first = end;
  for (const t of txns) if (t.tradeDate < first) first = t.tradeDate;
  const since = addDays(first, -perf.HISTORY_MARGIN_DAYS);
  const cached = resolveMarketInput(
    request,
    instruments.values(),
    request.order === undefined ? {} : { order: request.order },
  );
  let bars = new Map<InstrumentId, readonly PriceBar[]>();
  for (const id of ids) {
    const series = cached.series(id).filter((b) => since <= b.date && b.date <= end);
    if (series.length > 0) bars.set(id, series);
  }

  const manual = new Map<InstrumentId, ManualValuation[]>();
  for (const v of manualValuations(read)) {
    const list = manual.get(v.instrumentId) ?? [];
    list.push(v);
    manual.set(v.instrumentId, list);
  }
  for (const list of manual.values()) {
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }
  const currencies = new Set<Currency>([base]);
  for (const t of txns) {
    currencies.add(t.currency);
    currencies.add(t.cashCurrency);
  }
  for (const i of instruments.values()) currencies.add(i.currency);
  for (const list of manual.values()) for (const v of list) currencies.add(v.currency);
  const rates = [...currencies].flatMap((c) => cached.fxRates(c));
  const fx = new InMemoryFxLookup(preloadRates(rates, currencies, end, since));

  const proxy = proxyId === undefined ? null : (instruments.get(proxyId) ?? null);
  let benchmarkBars: readonly PriceBar[] = [];
  if (proxy !== null) {
    benchmarkBars = bars.get(proxy.id) ?? [];
    if (!referenced.has(proxy.id)) bars = new Map([...bars].filter(([k]) => k !== proxy.id));
  }
  return {
    base,
    policy: strategy.policy,
    plan: strategy.strategy?.allocation ?? null,
    benchmark,
    strategyState: strategy.state,
    accounts: brokerageAccounts(read).map((a) => ({
      id: a.gid as perf.PerformanceAccount["id"],
      name: a.name,
      currency: a.currency,
    })),
    txns: txns satisfies readonly Transaction[],
    renames,
    instruments,
    bars,
    manual,
    fx,
    benchmarkInstrument: proxy,
    benchmarkBars,
  };
}
