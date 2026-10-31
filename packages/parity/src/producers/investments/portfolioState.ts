/**
 * A profile's portfolio as of the dataset's `as_of`: the port of `service/portfolio.build` for the
 * parity producers. Loading reads only the read-only source; every number comes from the
 * `@cashu/domain` pipeline (`buildSnapshot` -> `valuePortfolio` -> `allocate`).
 */

import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import {
  barsBetween,
  daysBefore,
  fxRate,
  loadInstruments,
  manualValuation,
  pk,
  priceBar,
  ratesBetween,
  rename,
  sid,
  transaction,
} from "./rows.ts";
import type { StrategyInputs } from "./strategyBridge.ts";

/** Bars loaded for the market view (`build(history_days=800)`). */
const HISTORY_DAYS = 800;

export interface PortfolioState {
  readonly profileId: number;
  readonly asOf: string;
  readonly base: inv.Currency;
  readonly snapshot: inv.PortfolioSnapshot;
  readonly market: inv.MarketView;
  readonly valued: inv.ValuedPortfolio;
  readonly allocation: inv.AllocationResult | null;
}

/** `portfolio.base_currency(profile, strategy)`. */
function baseCurrency(baseOfProfile: string | null, inputs: StrategyInputs): inv.Currency {
  if (inputs.strategy !== null) return inputs.strategy.baseCurrency;
  if (baseOfProfile === null) throw new Error("profile without a base currency");
  return inv.toCurrency(baseOfProfile);
}

/** `service/portfolio.build(session, profile, as_of=db.asOf, strategy=...)` for all accounts. */
export function buildPortfolioState(
  db: PythonDb,
  profile: { readonly id: number; readonly baseCurrency: string | null },
  inputs: StrategyInputs,
): PortfolioState {
  const asOf = db.asOf;
  const pid = profile.id;
  const txns = db.investments.transactions(pid).map(transaction);
  const renames = db.investments.renames(pid).map(rename);
  const snapshot = inv.buildSnapshot(inv.asProfileId(sid(pid)), txns, asOf, { renames });

  const referenced = new Set<number>();
  for (const t of txns) if (t.instrumentId !== null) referenced.add(pk(t.instrumentId));
  for (const r of renames) {
    referenced.add(pk(r.oldInstrumentId));
    referenced.add(pk(r.newInstrumentId));
  }
  const loaded = loadInstruments(db, pid, referenced);
  const held = new Set(snapshot.holdings.map((h) => h.instrumentId));
  const listed = new Map([...loaded].filter(([id]) => held.has(id)));

  // market.market_view: bars of the listed instruments since as_of - 800 days, manual valuations
  // of the held instruments, sorted by date (stable).
  const allBars = db.investments.priceBars([...listed.keys()].map(pk)).map(priceBar);
  const bars = barsBetween(allBars, new Set(listed.keys()), asOf, daysBefore(asOf, HISTORY_DAYS));
  const valuations = new Map<inv.InstrumentId, inv.ManualValuation[]>();
  for (const v of db.investments.manualValuations(pid).map(manualValuation)) {
    if (!held.has(v.instrumentId) || !listed.has(v.instrumentId)) continue;
    const list = valuations.get(v.instrumentId) ?? [];
    list.push(v);
    valuations.set(v.instrumentId, list);
  }
  for (const list of valuations.values()) {
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }
  const market = inv.marketView({ asOf, instruments: listed, bars, manualValuations: valuations });

  const base = baseCurrency(profile.baseCurrency, inputs);
  // market.fx_lookup: every rate value_portfolio may ask for, preloaded.
  const needs = inv.fxCurrenciesFor(snapshot, market, base);
  const rates = ratesBetween(
    db.investments.fxRates().map(fxRate),
    needs.currencies,
    snapshot.asOf,
    needs.oldest,
  );
  const fx = new inv.InMemoryFxLookup(rates);
  const valued = inv.valuePortfolio(snapshot, market, fx, base, inputs.maxPriceAgeDays, {
    maxFxAgeDays: inputs.maxFxAgeDays,
  });
  const plan = inputs.strategy?.allocation ?? null;
  const allocation = plan !== null && plan.buckets.length > 0 ? inv.allocate(valued, plan) : null;
  return { profileId: pid, asOf, base, snapshot, market, valued, allocation };
}
