// history_metrics over a seeded synthetic profile: the trading-behaviour retrospective (activity, buys
// after a run-up, sells after a drawdown, holding days, fees, concentration) and the performance
// summary. It carries no money, so strict and amounts send the same answer.

import { D, parseDateTime } from "@cashu/domain";
import { asProfileId, Currencies, market, performance as perf } from "@cashu/domain/investments";
import {
  detGidFor,
  investmentsCommands,
  investmentsPerformance,
  investmentsServices,
  investmentsViews,
  openAccount,
  vaultSalt,
} from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { nativeFixture } from "../testing/native.js";
import { historyMetrics, historyQuarterEnds } from "./investmentsHistory.js";

interface Row {
  type: string;
  tradeDate: string;
  symbol: string | null;
  quantity: string | null;
  price: string | null;
  currency: string;
  grossAmount: string;
  fee: string;
  cashAmount: string;
}
interface History {
  today: string;
  rows: Row[];
  bars: { symbol: string; date: string; close: string }[];
}
const cash = (type: string, tradeDate: string, cashAmount: string): Row => ({
  type,
  tradeDate,
  symbol: null,
  quantity: null,
  price: null,
  currency: "PLN",
  grossAmount: "0",
  fee: "0",
  cashAmount,
});
const trade = (
  type: string,
  tradeDate: string,
  quantity: number,
  price: number,
  fee: number,
): Row => {
  const gross = quantity * price;
  return {
    type,
    tradeDate,
    symbol: "ABC",
    quantity: String(quantity),
    price: String(price),
    currency: "PLN",
    grossAmount: String(gross),
    fee: String(fee),
    cashAmount: String(type === "buy" ? -(gross + fee) : gross - fee),
  };
};
/** Daily ABC closes from 2025-08-01 to 2026-11-01, a step function changing on the given dates. */
function steps(changes: [string, number][]): History["bars"] {
  const bars: History["bars"] = [];
  let close = 0;
  for (let day = Date.parse("2025-08-01"); day <= Date.parse("2026-11-01"); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    for (const [at, value] of changes) if (at === date) close = value;
    bars.push({ symbol: "ABC", date, close: String(close) });
  }
  return bars;
}
// buys after a 30% run-up, sells after a drawdown, one winner and one loser
const BEHAVIOR: History = {
  today: "2026-11-01",
  rows: [
    cash("deposit", "2025-12-01", "5000"),
    trade("buy", "2025-12-01", 5, 100, 1),
    trade("sell", "2026-03-01", 2, 80, 1),
    trade("buy", "2026-07-01", 2, 160, 2),
    trade("sell", "2026-09-01", 2, 140, 2),
    cash("withdrawal", "2026-01-01", "-100"),
  ],
  bars: steps([
    ["2025-08-01", 100],
    ["2025-11-01", 130],
    ["2026-03-01", 80],
    ["2026-04-01", 100],
    ["2026-05-30", 120],
    ["2026-07-01", 160],
    ["2026-09-01", 140],
  ]),
};
const EMPTY: History = { today: "2026-11-01", rows: [], bars: [] };

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function prepare(vector: History, privacy: string) {
  const f = nativeFixture();
  fixtures.push(f);
  const account = f.run(openAccount, {
    bank: "dif",
    name: "Synthetic",
    type: "brokerage",
    currency: "PLN",
    externalId: "synthetic",
  });
  if (!account.ok) throw new Error(account.reason);
  const det = detGidFor(vaultSalt(new Uint8Array(32).fill(17)));
  const instruments = new Map<string, string>();
  for (const row of vector.rows)
    if (row.symbol !== null && !instruments.has(row.symbol)) {
      const i = f.run(investmentsCommands.createInstrument, {
        name: "Synthetic Equity",
        symbol: row.symbol,
        isin: "PLABC0000016",
        mic: "XWAR",
        currency: "PLN",
        assetClass: "equity",
        aliases: [{ namespace: "yahoo", value: `${row.symbol}.WA`, guessed: true }],
      });
      if (!i.ok) throw new Error(i.reason);
      instruments.set(row.symbol, i.value.gid);
    }
  for (const [n, row] of vector.rows.entries())
    f.seed(
      "invTxn.imported",
      {
        account: account.value.account,
        batch: null,
        type: row.type,
        tradeDate: row.tradeDate,
        settleDate: null,
        instrument: row.symbol === null ? null : instruments.get(row.symbol),
        quantity: row.quantity,
        price: row.price,
        currency: row.currency,
        grossAmount: row.grossAmount,
        fee: row.fee,
        tax: "0",
        cashAmount: row.cashAmount,
        cashCurrency: "PLN",
        fxRate: null,
        splitRatio: null,
        note: null,
        source: "import",
        externalRef: `R${n}`,
        dedupHash: n.toString(16).padStart(64, "0"),
        createdAt: `${row.tradeDate}T12:00:00Z`,
      },
      det("inv_transactions", [account.value.account, n.toString(16).padStart(64, "0")]),
    );
  const now = parseDateTime("2026-11-01T12:00:00Z");
  for (const symbol of instruments.keys())
    f.prices.upsertBars(
      market.marketSymbol("yahoo", `${symbol}.WA`),
      vector.bars
        .filter((b) => b.symbol === symbol)
        .map((b) => ({
          date: b.date,
          close: D(b.close),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: Currencies.PLN,
          fetchedAt: now,
        })),
      now,
    );
  const strategy = await investmentsServices.loadStrategy(f.store, {
    read: async () => null,
    write: async () => {},
    exists: async () => false,
  });
  const service = new investmentsPerformance.PerformanceService();
  const history = {
    portfolio: (asOf: string) => {
      const result = investmentsViews.portfolioAt(f.store.read.bind(f.store), {
        vault: asProfileId(f.vault),
        asOf,
        strategy,
        lang: "en",
        prices: f.prices,
      });
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    },
    performance: () =>
      service.historyMetrics(f.store, {
        prices: f.prices,
        asOf: vector.today,
        strategy: {
          state: "missing",
          benchmark: null,
          policy: perf.DEFAULT_VALUATION_POLICY,
          strategy: null,
        },
      }),
  };
  const ctx = f.context(privacy);
  return {
    ...ctx,
    today: vector.today,
    store: { ...ctx.store, today: vector.today, investmentHistory: history },
  };
}
function answer(ctx: Awaited<ReturnType<typeof prepare>>) {
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const result = redactor.apply(historyMetrics(ctx));
  leakCheck(result, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(result));
}
it("says there is no history yet on an empty profile", async () => {
  expect(answer(await prepare(EMPTY, "strict"))).toEqual({
    note: "no investments history yet",
    trades: 0,
  });
});
it("reports the behavioural retrospective and performance, the same in strict and amounts", async () => {
  const strict = answer(await prepare(BEHAVIOR, "strict"));
  expect(answer(await prepare(BEHAVIOR, "amounts"))).toEqual(strict);
  expect(strict.activity).toEqual({
    days_since_last_trade: 61,
    first_trade: "2025-12-01",
    gaps_over_180_days: 0,
    gaps_over_90_days: 1,
    last_trade: "2026-09-01",
    max_gap_days: 122,
    median_gap_days: 90,
    trades: 4,
  });
  expect(strict.buys_after_runup).toEqual({
    buys_after_runup: 2,
    buys_checked: 2,
    lookback_days: 90,
    threshold: 0.2,
  });
  expect(strict.sells_after_drawdown).toEqual({
    median_drawdown_at_sale: 0.254808,
    sells_at_or_below_threshold: 1,
    sells_checked: 2,
    threshold: 0.15,
  });
  expect(strict.holding_days).toEqual({
    losers: 1,
    losers_median_days: 90,
    winners: 1,
    winners_median_days: 274,
  });
  expect(strict.price_after_sales).toEqual([
    { days: 30, median_change: 0.0, sales: 2, share_rose: 0.0 },
    { days: 90, median_change: 0.5, sales: 1, share_rose: 1.0 },
    { days: 180, median_change: 1.0, sales: 1, share_rose: 1.0 },
  ]);
  expect(strict.deposits_per_year).toEqual([
    { deposits: 1, withdrawals: 0, year: 2025 },
    { deposits: 0, withdrawals: 1, year: 2026 },
  ]);
  expect(strict.fees_pct_of_turnover).toEqual([{ currency: "PLN", fees_share: 0.004762 }]);
  expect(strict.concentration.map((c: { date: string }) => c.date)).toEqual([
    "2025-12-31",
    "2026-03-31",
    "2026-06-30",
    "2026-09-30",
    "2026-11-01",
  ]);
  expect(strict.concentration[0]).toEqual({
    date: "2025-12-31",
    largest: 0.126238,
    positions: 1,
    top3: 0.126238,
  });
  expect(strict.performance.return).toEqual({
    days: 336,
    money_weighted: 0.006926,
    twr: -0.022777,
    twr_annualized: null,
    xirr: null,
  });
  expect(strict.performance.max_drawdown).toMatchObject({
    portfolio: -0.049713,
    portfolio_peak: "2025-11-30",
    portfolio_trough: "2026-03-01",
  });
  expect(strict.performance.benchmark.status).toBe("no_strategy");
});
it("keeps quarter-end duplication, caps at forty points and retains the latest date", () => {
  expect(historyQuarterEnds("2026-07-02", "2026-09-30")).toEqual(["2026-09-30", "2026-09-30"]);
  const points = historyQuarterEnds("2000-01-01", "2026-11-01");
  expect(points).toHaveLength(40);
  expect(points.at(-1)).toBe("2026-11-01");
});
it("retains the behavioral retrospective when performance fails", async () => {
  const ctx = await prepare(BEHAVIOR, "strict");
  const store = {
    ...ctx.store,
    investmentHistory: {
      ...ctx.store.investmentHistory,
      performance: () => {
        throw new Error("synthetic failure");
      },
    },
  };
  const result = historyMetrics({ ...ctx, store });
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const plain = JSON.parse(pyDumps(redactor.apply(result)));
  expect(plain.activity.trades).toBe(4);
  expect(plain.performance).toEqual({ note: "performance metrics could not be computed" });
});
