// Backtest of a proposed rule on the profile's own history: weekly raw evaluations anchored at today,
// cooldown not applied, missing data skipped, and a private holding's symbol never reported.
import { addDays, D, parseDateTime } from "@cashu/domain";
import { asProfileId, Currencies, market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { memoryDriver } from "../../testing/store.js";
import { createInstrument } from "../commands/instruments.js";
import { addManualTransaction } from "../commands/manual.js";
import { brokerage, vault } from "../commands/testing/fixtures.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { SqlPriceCache } from "../local/priceCache.js";
import { backtestProposalRule } from "./proposalBacktest.js";
import { loadStrategy } from "./strategy.js";

const TODAY = "2026-10-31";
const yaml = (kind: string, params: string) => `version: 1
base_currency: PLN
data: {max_price_age_days: 100000, max_stale_weight: 1, max_unclassified_weight: 1}
buckets:
  - {id: holdings, match: {asset_class: [equity, other]}}
  - {id: cash, match: {asset_class: cash}}
allocation: {targets: {holdings: 0.9, cash: 0.1}}
rules:
  - id: synthetic
    kind: ${kind}
    severity: action
    cooldown_days: 365
    params: ${params}
`;
const CASH = yaml("cash_level", "{max_weight: 0.5}");

interface Case {
  readonly yaml: string;
  /** Days of history before today (null: no transactions at all). */
  readonly days: number | null;
  /** Day offsets from the start of alternating buy / sell trades of one instrument. */
  readonly trades?: readonly number[];
  readonly private?: boolean;
  /** Weekly bars for the instrument. */
  readonly bars?: boolean;
}

async function backtest(c: Case) {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  const account = brokerage(v, "Synthetic brokerage");
  const strategy = await loadStrategy(v.store, {
    read: async (name) => (name === "strategy.yaml" ? c.yaml : null),
    write: async () => {},
    exists: async () => true,
  });
  const rule = strategy.config?.rules[0];
  if (rule === undefined) throw new Error("synthetic rule invalid");
  const symbol = c.private ? "PRIVATE999" : "SYNTH";
  const instrument = c.trades?.length
    ? v.value(createInstrument, {
        name: "Synthetic holding",
        symbol,
        currency: "PLN",
        assetClass: c.private ? "other" : "equity",
        valuationMode: "market",
        aliases: [{ namespace: "yahoo", value: symbol }],
      }).gid
    : null;
  if (instrument !== null) v.value(addToWatchlist, { target: { stored: instrument } });
  if (c.days !== null) {
    const start = addDays(TODAY, -c.days);
    v.value(addManualTransaction, {
      account,
      type: "deposit",
      tradeDate: start,
      cashAmount: "1000",
      currency: "PLN",
    });
    for (const [index, offset] of (c.trades ?? []).entries()) {
      const buy = index % 2 === 0;
      v.value(addManualTransaction, {
        account,
        instrument,
        type: buy ? "buy" : "sell",
        tradeDate: addDays(start, offset),
        quantity: "10",
        price: "100",
        currency: "PLN",
        cashAmount: buy ? "-1000" : "1000",
      });
    }
  }
  const driver = memoryDriver();
  const prices = new SqlPriceCache(driver);
  if (c.bars && c.days !== null) {
    const bars: market.CachedBar[] = [];
    for (let offset = 0; offset <= c.days; offset += 7)
      bars.push({
        date: addDays(TODAY, -c.days + offset),
        close: D("100"),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: Currencies.PLN,
        fetchedAt: null,
      });
    prices.upsertBars(market.marketSymbol("yahoo", symbol), bars, parseDateTime(`${TODAY}T12:00Z`));
  }
  try {
    return backtestProposalRule(v.store.read.bind(v.store), {
      vault: asProfileId(v.store.vault),
      today: TODAY,
      strategy,
      rule,
      lang: "en",
      prices,
    });
  } finally {
    driver.close();
    v.store.close();
  }
}

describe("proposal rule backtest", () => {
  it("says there is no history yet", async () => {
    expect(await backtest({ yaml: CASH, days: null })).toEqual({
      evaluated: 0,
      note: "no transaction history yet",
    });
  });

  it("samples weekly back from today", async () => {
    expect(await backtest({ yaml: CASH, days: 15 })).toMatchObject({
      evaluated: 3,
      step_days: 7,
      from: "2026-10-16",
      to: TODAY,
      fired_dates: ["2026-10-17", "2026-10-24", TODAY],
      episodes: 1,
      points_skipped: 0,
    });
  });

  it("counts raw episodes without the cooldown", async () => {
    // cash above 50 % between the trades: fires, clears, fires again
    expect(await backtest({ yaml: CASH, days: 28, trades: [7, 14, 21, 28] })).toMatchObject({
      evaluated: 5,
      points_fired: 3,
      episodes: 3,
      first_fired: "2026-10-03",
      last_fired: TODAY,
    });
  });

  it("names a quoted instrument but never a private holding's symbol", async () => {
    const rule = yaml("position_concentration", "{max_weight: 0.5}");
    const quoted = await backtest({ yaml: rule, days: 14, trades: [0], bars: true });
    expect(quoted).toMatchObject({ points_fired: 3, instruments: ["SYNTH"] });
    const hidden = await backtest({ yaml: rule, days: 14, trades: [0], bars: true, private: true });
    expect(hidden).toMatchObject({ points_fired: 3, instruments: [] });
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE999");
  });

  it("never fires on missing prices and says why", async () => {
    const rule = yaml("drawdown_from_high", "{threshold: 0.2, window_days: 30}");
    expect(await backtest({ yaml: rule, days: 14, trades: [0] })).toMatchObject({
      evaluated: 3,
      points_fired: 0,
      points_skipped: 3,
      skip_reasons: ["No prices: SYNTH"],
    });
  });
});
