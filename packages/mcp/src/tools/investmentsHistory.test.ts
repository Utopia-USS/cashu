/** Actual Python handlers generated these synthetic outputs; TS reconstructs independent native facts. */

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
import vectors from "./fixtures/investments-history.json" with { type: "json" };
import { historyMetrics, historyQuarterEnds } from "./investmentsHistory.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function prepare(vector: (typeof vectors)[number], privacy: string) {
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
for (const vector of vectors)
  it.each(["strict", "amounts"])(
    `matches actual Python history_metrics ${vector.label} in %s`,
    async (privacy) => {
      const ctx = await prepare(vector, privacy);
      const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
      const result = redactor.apply(historyMetrics(ctx));
      leakCheck(result, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
      const expected = privacy === "strict" ? vector.expected.strict : vector.expected.amounts;
      expect(JSON.parse(pyDumps(result))).toEqual(expected);
    },
  );
it("keeps quarter-end duplication, caps at forty points and retains the latest date", () => {
  expect(historyQuarterEnds("2026-07-02", "2026-09-30")).toEqual(["2026-09-30", "2026-09-30"]);
  const points = historyQuarterEnds("2000-01-01", "2026-11-01");
  expect(points).toHaveLength(40);
  expect(points.at(-1)).toBe("2026-11-01");
});
it("retains the behavioral retrospective when performance fails", async () => {
  const vector = vectors.find((v) => v.label === "behavior");
  if (!vector) throw new Error("missing fixture");
  const ctx = await prepare(vector, "strict");
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
