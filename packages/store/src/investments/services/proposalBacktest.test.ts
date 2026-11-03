// Expected vectors are actual isolated Python backtest/portfolio/RulesEngine outputs. Native input
// histories and an actual empty device-local price DB are constructed independently below.
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
import vectors from "./fixtures/proposalBacktest.json" with { type: "json" };
import { backtestProposalRule } from "./proposalBacktest.js";
import { loadStrategy } from "./strategy.js";

describe("proposal rule backtest: actual Python synthetic vectors", () => {
  for (const vector of vectors) {
    it(vector.name, async () => {
      const v = vault();
      v.value(createProfile, {
        slug: "synthetic",
        name: "Synthetic backtest",
        modules: ["investments"],
      });
      const account = brokerage(v, "Synthetic brokerage");
      const strategy = await loadStrategy(v.store, {
        read: async (name) => (name === "strategy.yaml" ? vector.yaml : null),
        write: async () => {
          throw new Error("read-only synthetic strategy");
        },
        exists: async () => true,
      });
      if (strategy.config === null) throw new Error("synthetic strategy invalid");
      const rule = strategy.config.rules[0];
      if (rule === undefined) throw new Error("synthetic rule invalid");
      const instrument = vector.trades?.length
        ? v.value(createInstrument, {
            name: vector.private ? "Synthetic private holding" : "Synthetic quoted holding",
            symbol: vector.private ? "PRIVATE999" : "SYNTH",
            currency: "PLN",
            assetClass: vector.private ? "other" : "equity",
            valuationMode: "market",
            aliases: [{ namespace: "yahoo", value: vector.private ? "PRIVATE999" : "SYNTH" }],
          }).gid
        : null;
      if (instrument !== null) v.value(addToWatchlist, { target: { stored: instrument } });
      if (vector.days !== null) {
        const start = addDays(vector.today, -vector.days);
        v.value(addManualTransaction, {
          account,
          type: "deposit",
          tradeDate: start,
          cashAmount: "1000",
          currency: "PLN",
        });
        for (const [index, offset] of (vector.trades ?? []).entries()) {
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
      if (vector.kind === "position_concentration" && vector.days !== null) {
        const bars: market.CachedBar[] = [];
        for (let offset = 0; offset <= vector.days; offset += 7)
          bars.push({
            date: addDays(vector.today, -vector.days + offset),
            close: D("100"),
            open: null,
            high: null,
            low: null,
            volume: null,
            currency: Currencies.PLN,
            fetchedAt: null,
          });
        prices.upsertBars(
          market.marketSymbol("yahoo", vector.private ? "PRIVATE999" : "SYNTH"),
          bars,
          parseDateTime(`${vector.today}T12:00:00Z`),
        );
      }
      const report = backtestProposalRule(v.store.read.bind(v.store), {
        vault: asProfileId(v.store.vault),
        today: vector.today,
        strategy,
        rule,
        lang: "en",
        prices,
      });
      expect(report).toEqual(vector.expected);
      expect(vector.strict).toEqual(report);
      expect(vector.amounts).toEqual(report);
      if ("instruments" in report) {
        expect(report.instruments).not.toContain("PRIVATE999");
        expect(report.skip_reasons.every((reason) => !/\p{Nd}/u.test(reason))).toBe(true);
      }
      if (vector.name === "divisor_260_yields_261") expect(report.evaluated).toBe(261);
      if (vector.name === "end_anchored" && "first_fired" in report) {
        expect(report.from).toBe(addDays(vector.today, -15));
        expect(report.first_fired).toBe(addDays(vector.today, -14));
      }
      if (vector.name === "raw_episodes" && "episodes" in report) {
        expect(report.episodes).toBe(3);
        expect(report.points_fired).toBe(3);
      }
      if (vector.name === "missing_bars" && "points_skipped" in report)
        expect(report.points_skipped).toBeGreaterThan(0);
      if (vector.name === "public_instrument" && "instruments" in report)
        expect(report.instruments).toEqual(["SYNTH"]);
      driver.close();
      v.store.close();
    });
  }
});
