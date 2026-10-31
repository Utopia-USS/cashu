// The pure service helpers, the benchmark proxy planning and the backfill plan. Translates
// tests/investments/performance/test_perf_report.py::test_sample,
// test_fixb_benchmark_proxy.py::test_reference_instrument_follows_the_market_symbol_conventions and
// the plan / probe parts of test_perf_pipeline.py::test_import_backfill_endpoint (roles, need-from
// dates, the probe settling the quote currency). Invented values only.

import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import { D } from "../../decimal.js";
import { AliasNamespace, aliasOf } from "../domain/instrument.js";
import { priceBar } from "../domain/marketData.js";
import { asInstrumentId, type CalendarDate, type Currency } from "../domain/values.js";
import {
  type PriceSource,
  priceHistory,
  QuoteCurrencyMismatchException,
  SourceException,
} from "../market/sources.js";
import { HEAD_MARGIN_DAYS, planBackfill, planBenchmark, probeProxy } from "./backfill.js";
import { referenceInstrument } from "./proxy.js";
import { checkRange, isIsin, PerformanceRangeError, sample } from "./service.js";
import { EUR, instrument, PLN, txn } from "./testing/support.js";

const span = (start: string, n: number): CalendarDate[] =>
  Array.from({ length: n }, (_, i) => addDays(start, i));

describe("sample (test_perf_report.test_sample)", () => {
  it("is daily up to ~13 months, weekly up to ~5 years, month ends beyond", () => {
    const short = span("2025-01-01", 365);
    expect(sample(short)).toEqual(["day", short.map((_, i) => i)]);
    const three = span("2022-01-01", 1100);
    const [step, picked] = sample(three);
    expect([step, picked[0], picked.at(-1)]).toEqual(["week", 0, 1099]);
    for (let k = 2; k < picked.length; k++) {
      expect((picked[k] as number) - (picked[k - 1] as number)).toBe(7);
    }
    const long = span("2018-01-01", 2500);
    const [monthly, ends] = sample(long);
    expect([monthly, ends[0], ends.at(-1)]).toEqual(["month", 0, 2499]);
    for (const i of ends.slice(1, -1)) {
      expect(["28", "29", "30", "31"]).toContain((long[i] as string).slice(8));
    }
  });
});

describe("range keys and ISINs", () => {
  it("accepts the six ranges and names them in the error", () => {
    expect(checkRange("ytd")).toBe("ytd");
    expect(() => checkRange("5y")).toThrow(PerformanceRangeError);
    expect(() => checkRange("week")).toThrow("range must be one of 1m, 3m, ytd, 1y, 3y, max");
  });

  it("recognises an ISIN case-insensitively, trimmed", () => {
    expect(isIsin(" ie00b3rbwm25 ")).toBe(true);
    expect(isIsin("IUSQ.DE")).toBe(false);
  });
});

describe("referenceInstrument (test_reference_instrument_follows_the_market_symbol_conventions)", () => {
  it("plans a guessed-alias instrument from a known market suffix only", () => {
    const planned = referenceInstrument("IUSQ.DE");
    expect([planned?.symbol, planned?.mic, planned?.currency]).toEqual(["IUSQ", "XETR", EUR]);
    expect(planned && aliasOf(planned, AliasNamespace.YAHOO)).toBe("IUSQ.DE");
    expect(planned && aliasOf(planned, AliasNamespace.STOOQ)).toBe("iusq.de");
    expect(planned?.aliases.every((a) => a.guessed)).toBe(true);
    expect(planned?.needsClassification).toBe(false);
    expect(referenceInstrument("IE00B3RBWM25")).toBeNull(); // an ISIN must be a stored instrument
    expect(referenceInstrument("SPY")).toBeNull(); // no market suffix: left to the online probe
    expect(referenceInstrument(" ")).toBeNull();
    expect(referenceInstrument(null)).toBeNull();
  });
});

describe("planBackfill", () => {
  const abc = instrument("abc", PLN);
  const wrld = instrument("wrld", EUR);
  const txns = [
    txn("deposit", "2025-01-02", "10000"),
    txn("buy", "2025-01-03", "-5000", { instrument: "abc", quantity: "50", price: "100" }),
    txn("buy", "2025-01-06", "-4300", {
      instrument: "wrld",
      quantity: "10",
      price: "100",
      currency: EUR,
      cashCurrency: PLN,
    }),
    txn("sell", "2025-06-02", "6000", { instrument: "abc", quantity: "50", price: "120" }),
    txn("deposit", "2025-07-01", "2000"),
    txn("deposit", "2025-10-05", "1"), // after as_of: ignored
  ];
  const load = (ids: readonly string[]) =>
    new Map([abc, wrld].filter((i) => ids.includes(i.id)).map((i) => [i.id, i] as const));

  it("plans held and sold instruments from their first trade, currencies from the first day", () => {
    const plan = planBackfill({ txns, renames: [], load, base: PLN, asOf: "2025-09-30" });
    expect(plan.first).toBe("2025-01-02");
    expect(Object.fromEntries(plan.roles)).toEqual({ abc: "sold", wrld: "held" });
    expect(Object.fromEntries(plan.needFrom)).toEqual({ abc: "2025-01-03", wrld: "2025-01-06" });
    expect(Object.fromEntries(plan.currencies)).toEqual({ PLN: "2025-01-02", EUR: "2025-01-02" });
    // the report's need-from is the plan's minus the head margin (ABC 2024-12-27)
    expect(addDays(plan.needFrom.get(asInstrumentId("abc")) as string, -HEAD_MARGIN_DAYS)).toBe(
      "2024-12-27",
    );
    const proxy = instrument("bnch", EUR);
    planBenchmark(plan, proxy, plan.first as string);
    expect(plan.roles.get(proxy.id)).toBe("benchmark");
    expect(plan.needFrom.get(proxy.id)).toBe("2025-01-02");
  });

  it("is empty without transactions up to as_of", () => {
    const plan = planBackfill({ txns, renames: [], load, base: PLN, asOf: "2025-01-01" });
    expect([plan.first, plan.instruments.size, plan.currencies.size]).toEqual([null, 0, 0]);
  });
});

/** Answers like the fake Yahoo of perf_support: a bar per day, a wrong currency is refused. */
function fakePrices(quote: Currency, calls: string[] = []): PriceSource {
  return {
    id: "yahoo",
    async fetch(inst, start, end) {
      calls.push(`${inst.currency} ${start}..${end}`);
      if (inst.currency !== quote) {
        throw new QuoteCurrencyMismatchException("yahoo", `quoted in ${quote}`, {
          quoteCurrency: quote,
          instrumentCurrency: inst.currency,
        });
      }
      const bars = span(start, 15).map((date) =>
        priceBar({ instrumentId: inst.id, date, close: D("50"), source: "yahoo", currency: quote }),
      );
      return priceHistory({ bars, currency: quote });
    },
  };
}

describe("probeProxy", () => {
  it("settles the quote currency the source answers with (guessed in the base currency)", async () => {
    const calls: string[] = [];
    const out = await probeProxy(fakePrices(EUR, calls), " bnch.de", PLN, "2025-09-30");
    expect(out.ok && [out.instrument.currency, out.instrument.symbol]).toEqual([EUR, "BNCH"]);
    expect(calls).toEqual(["PLN 2025-09-16..2025-09-30", "EUR 2025-09-16..2025-09-30"]);
  });

  it("reports an empty answer and a source error as messages", async () => {
    const empty: PriceSource = { id: "yahoo", fetch: async () => priceHistory() };
    expect(await probeProxy(empty, "NOPE.XX", PLN, "2025-09-30")).toEqual({
      ok: false,
      message: "no prices for NOPE.XX in the last 14 days",
    });
    const down: PriceSource = {
      id: "yahoo",
      fetch: async () => {
        throw new SourceException("yahoo", "HTTP 503", { retryable: true });
      },
    };
    expect(await probeProxy(down, "BNCH.DE", PLN, "2025-09-30")).toEqual({
      ok: false,
      message: "yahoo: HTTP 503",
    });
  });
});
