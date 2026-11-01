/**
 * Producer of `investments.performance` (`parity/python/checks/investments.py:performance`): per
 * profile with the investments module, `performance_view` for every range and `attribution_view` for
 * `max`, as of the dataset's `as_of`, every account.
 *
 * Loading is the port of `performance/service.load` over the read-only Python database (rows ->
 * domain values as `rows.ts` converts them, domain ids = the app's `str(pk)`); the computation and
 * the views are the `@cashu/domain` performance service (`computePerformance`, `performanceView`,
 * `attributionView`), the same functions the store's performance service runs over a vault
 * (`@cashu/store` investments performance). `performanceOut.ts` writes the views in the golden's
 * canonical form.
 */

import { investments as inv, pyLower, pyStrip, pyUpper } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { performanceOut } from "./performanceOut.ts";
import {
  barsBetween,
  daysBefore,
  fxRate,
  loadInstruments,
  manualValuation,
  pk,
  priceBar,
  rename,
  sid,
  transaction,
} from "./rows.ts";
import { Serializer } from "./serialize.ts";
import type { StrategyInputs, StrategyInputsByProfile } from "./strategy.ts";

const MODULE = "investments";
const perf = inv.performance;
type CalendarDate = inv.CalendarDate;

/**
 * `service.find_proxy`: the stored instrument a strategy `benchmark.proxy` names, by ISIN (column,
 * then an `isin` alias), else by its yahoo alias (as written, upper, lower case), else stooq. Returns
 * the row id.
 */
export function findProxy(db: PythonDb, proxy: string): number | null {
  const value = pyStrip(proxy);
  if (value === "") return null;
  if (perf.isIsin(value)) {
    const wanted = pyUpper(value);
    const byColumn = db.investments.instrumentIdByIsin(wanted);
    if (byColumn !== null) return byColumn;
    const byAlias = db.investments.instrumentIdByAlias(inv.AliasNamespace.ISIN, wanted);
    if (byAlias !== null) return byAlias;
  }
  for (const namespace of [inv.AliasNamespace.YAHOO, inv.AliasNamespace.STOOQ]) {
    // dict.fromkeys: each distinct variant once, in this order; `_normalize` strips non-ISIN values
    for (const variant of new Set([value, pyUpper(value), pyLower(value)])) {
      const found = db.investments.instrumentIdByAlias(namespace, pyStrip(variant));
      if (found !== null) return found;
    }
  }
  return null;
}

/** `portfolio.base_currency(profile, strategy)`. */
function baseCurrency(baseOfProfile: string | null, inputs: StrategyInputs): inv.Currency {
  if (inputs.strategy !== null) return inputs.strategy.baseCurrency;
  if (baseOfProfile === null) throw new Error("profile without a base currency");
  return inv.toCurrency(baseOfProfile);
}

/** `service.load(session, profile, end)` over the read-only source. */
function loadPerformance(
  db: PythonDb,
  profile: { readonly id: number; readonly baseCurrency: string | null },
  inputs: StrategyInputs,
  end: CalendarDate,
): inv.performance.PerformanceInputs {
  const pid = profile.id;
  const base = baseCurrency(profile.baseCurrency, inputs);
  const policy = { maxPriceAgeDays: inputs.maxPriceAgeDays, maxFxAgeDays: inputs.maxFxAgeDays };
  const txns = db.investments
    .transactions(pid)
    .map(transaction)
    .filter((t) => t.tradeDate <= end);
  const renames = db.investments.renames(pid).map(rename);
  const referenced = new Set<number>();
  for (const t of txns) if (t.instrumentId !== null) referenced.add(pk(t.instrumentId));
  for (const r of renames) {
    referenced.add(pk(r.oldInstrumentId));
    referenced.add(pk(r.newInstrumentId));
  }
  const benchmark = inputs.strategy === null ? null : inputs.benchmark;
  const proxyPk = benchmark === null ? null : findProxy(db, benchmark.proxy);
  const pks = new Set(referenced);
  if (proxyPk !== null) pks.add(proxyPk);
  // the profile's own view of every instrument (overrides applied), like the overview
  const instruments = loadInstruments(db, pid, pks);
  let first = end;
  for (const t of txns) if (t.tradeDate < first) first = t.tradeDate;
  const since = daysBefore(first, perf.HISTORY_MARGIN_DAYS);
  const allBars = db.investments.priceBars([...pks]).map(priceBar);
  const ids = new Set([...pks].map((p) => inv.asInstrumentId(sid(p))));
  let bars = barsBetween(allBars, ids, end, since);

  const manual = new Map<inv.InstrumentId, inv.ManualValuation[]>();
  for (const v of db.investments.manualValuations(pid).map(manualValuation)) {
    const list = manual.get(v.instrumentId) ?? [];
    list.push(v);
    manual.set(v.instrumentId, list);
  }
  for (const list of manual.values()) {
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }
  const currencies = new Set<inv.Currency>([base]);
  for (const t of txns) {
    currencies.add(t.currency);
    currencies.add(t.cashCurrency);
  }
  for (const i of instruments.values()) currencies.add(i.currency);
  for (const list of manual.values()) for (const v of list) currencies.add(v.currency);
  const fx = new inv.InMemoryFxLookup(
    inv.preloadRates(db.investments.fxRates().map(fxRate), currencies, end, since),
  );

  // `load_one`: only the proxy's id and currency are read, which a profile override never changes
  const proxy =
    proxyPk === null ? null : (instruments.get(inv.asInstrumentId(sid(proxyPk))) ?? null);
  let benchmarkBars: readonly inv.PriceBar[] = [];
  if (proxy !== null) {
    benchmarkBars = bars.get(proxy.id) ?? [];
    if (!referenced.has(pk(proxy.id))) {
      bars = new Map([...bars].filter(([k]) => k !== proxy.id));
    }
  }
  const accountRows = new Map(db.accounts(pid, { includeRemoved: true }).map((a) => [a.id, a]));
  const accounts = db.investments.brokerageAccounts(pid).map((a) => {
    const row = accountRows.get(a.id);
    if (row === undefined) throw new Error("brokerage account without its account row");
    return { id: inv.asAccountId(sid(a.id)), name: row.name, currency: row.currency };
  });
  return {
    base,
    plan: inputs.strategy?.allocation ?? null,
    benchmark,
    strategyState: inputs.state,
    accounts,
    txns,
    renames,
    instruments,
    fx,
    benchmarkInstrument: proxy,
    benchmarkBars,
    bars,
    manual,
    policy,
  };
}

export function producePerformance(db: PythonDb, strategies: StrategyInputsByProfile): OutValue {
  const s = new Serializer(db);
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes(MODULE)) continue;
    const key = db.keys.key("profiles", p.id);
    const inputs = strategies.get(key);
    if (inputs === undefined) throw new Error("no strategy inputs for a profile");
    const computed = perf.computePerformance(loadPerformance(db, p, inputs, db.asOf), db.asOf);
    const views: Record<string, OutValue> = {};
    for (const range of perf.RANGES) {
      views[range] = performanceOut(perf.performanceView(computed, range), s);
    }
    out[key] = {
      performance: views,
      attribution_max: performanceOut(perf.attributionView(computed, "max"), s),
    };
  }
  return out;
}
