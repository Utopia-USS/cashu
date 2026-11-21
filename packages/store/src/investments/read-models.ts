// Investments reads for the overview and the blank page: the brokerage accounts' net-worth source
// (Python `investments/networth.py`: holdings plus broker cash, valued from the stored prices) and the
// setup facts (`investments/setup.py`). Prices and FX rates come from the device's price cache (never
// view tables, events.md 10); without one the valuation falls back to the last trade prices.
import {
  asProfileId,
  BrokerageContributor,
  type BrokerageHistory,
  type Currency,
  type FxRate,
  type Instrument,
  type InstrumentId,
  type InvestmentsSetupFacts,
  investmentsSetupSteps,
  market,
  type PriceBar,
} from "@cashu/domain/investments";
import type { NetWorthSource, SetupSource } from "../registry.js";
import { loadInstruments } from "./queries/instruments.js";
import type { Read } from "./queries/shared.js";
import { BROKERAGE, manualValuations, renames, transactions } from "./queries/transactions.js";

/**
 * The vault's investments history as net worth loads it (Python `_ProfileHistory`): every
 * transaction and rename, the instruments they reference as this profile sees them, their manual
 * valuations, and from the price cache every bar of those instruments and every rate of the
 * currencies involved.
 */
function brokerageHistory(
  read: Read,
  prices: market.PriceCache | null,
  marketData?: market.CachedMarketData,
): BrokerageHistory {
  const txns = transactions(read);
  const renamed = renames(read);
  const ids = new Set<InstrumentId>();
  for (const t of txns) if (t.instrumentId !== null) ids.add(t.instrumentId);
  for (const r of renamed) {
    ids.add(r.oldInstrumentId);
    ids.add(r.newInstrumentId);
  }
  const instruments = new Map<InstrumentId, Instrument>();
  for (const [gid, i] of loadInstruments(read, ids)) instruments.set(gid as InstrumentId, i);
  const valuations = manualValuations(read, ids);
  const bars: PriceBar[] = [];
  const rates: FxRate[] = [];
  if (prices !== null || marketData !== undefined) {
    const cached =
      marketData ?? market.cachedMarketData(prices as market.PriceCache, instruments.values());
    for (const id of ids) bars.push(...cached.series(id));
    const currencies = new Set<Currency>();
    for (const a of read<{ currency: Currency }>(
      "SELECT DISTINCT currency FROM accounts WHERE type = ?",
      BROKERAGE,
    )) {
      currencies.add(a.currency);
    }
    for (const t of txns) {
      currencies.add(t.currency);
      currencies.add(t.cashCurrency);
    }
    for (const i of instruments.values()) currencies.add(i.currency);
    for (const v of valuations) currencies.add(v.currency);
    for (const c of [...currencies].sort()) rates.push(...cached.fxRates(c));
  }
  return {
    profileId: asProfileId("0"),
    txns,
    renames: renamed,
    instruments,
    manualValuations: valuations,
    bars,
    rates,
  };
}

export const investmentsNetWorth: NetWorthSource = (read, env) =>
  new BrokerageContributor(brokerageHistory(read, env.prices, env.marketData), env.today);

const exists = (read: Read, sql: string, ...params: string[]): boolean =>
  read<{ one: number }>(sql, ...params).length > 0;

/**
 * The facts behind the investments steps (Python `setup_status`). The strategy exists once a version
 * of its documents is stored (the vault's copy of `strategy.yaml`).
 */
function investmentsSetupFacts(read: Read): InvestmentsSetupFacts {
  return {
    hasAccount: exists(read, "SELECT 1 AS one FROM accounts WHERE type = ? LIMIT 1", BROKERAGE),
    hasStrategy: exists(read, "SELECT 1 AS one FROM inv_strategy_versions LIMIT 1"),
    hasTransaction: exists(
      read,
      `SELECT 1 AS one FROM inv_transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.type = ? LIMIT 1`,
      BROKERAGE,
    ),
    hasRun: exists(
      read,
      "SELECT 1 AS one FROM inv_rule_runs WHERE status IN ('ok', 'partial') LIMIT 1",
    ),
  };
}

export const investmentsSetup: SetupSource = (read, ctx) =>
  investmentsSetupSteps(investmentsSetupFacts(read), ctx);
