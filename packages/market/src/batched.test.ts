// Batched quotes for the price refresh (P10): Yahoo spark and NBP tables parsing, and the batched sources'
// fallback rules (tests/investments/market/test_p10_batched.py). Fake fetch, synthetic bodies in Yahoo's
// and NBP's recorded shapes.

import { D } from "@cashu/domain";
import {
  type CalendarDate,
  Currencies,
  type Currency,
  type FxRate,
  fxRate,
  type Instrument,
  instrumentAlias,
  market as m,
  priceBar,
  toCurrency,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { NbpFxSource, YahooPriceSource } from "./sources.js";
import {
  buildInstrument,
  fakeClock,
  type Handler,
  makeHttp,
  orlen,
  recording,
  respond,
  type SeenRequest,
  utc,
  vwce,
  weekdays,
} from "./testing/support.js";

/** One spark result as Yahoo serves it (sessions stamped 13:30 UTC, gmtoffset 0, closes only). */
function sparkEntry(symbol: string, currency: string, closes: Map<string, number>) {
  const days = [...closes.keys()].sort();
  const stamp = (on: string) => {
    const [y, mo, dd] = on.split("-").map(Number) as [number, number, number];
    return utc(y, mo, dd, 13, 30);
  };
  return {
    symbol,
    response: [
      {
        meta: { currency, symbol, gmtoffset: 0 },
        timestamp: days.map(stamp),
        indicators: { quote: [{ close: days.map((on) => closes.get(on)) }] },
      },
    ],
  };
}

const sparkBody = (...entries: unknown[]) =>
  JSON.stringify({ spark: { result: entries, error: null } });
const closes = (start: string, end: string, value: number) =>
  new Map(weekdays(start, end).map((on) => [on, value]));

/** Records which instruments went the per-instrument way; answers one bar at `end`. */
class Fallback implements m.PriceSource {
  readonly id: string = "fallback";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];
  async fetch(target: Instrument, start: CalendarDate, end: CalendarDate): Promise<m.PriceHistory> {
    this.calls.push([target.symbol || target.name, start, end]);
    return m.priceHistory({
      bars: [priceBar({ instrumentId: target.id, date: end, close: D("1"), source: "fallback" })],
    });
  }
}

const usStock = (symbol: string, currency: Currency = Currencies.USD) =>
  buildInstrument({
    name: symbol,
    symbol,
    mic: "XNAS",
    currency,
    aliases: [instrumentAlias("yahoo", symbol)],
  });

const yahooOver = (requests: SeenRequest[], handler: Handler) =>
  new YahooPriceSource(makeHttp(recording(requests, handler)), { clock: fakeClock });

// --- Yahoo spark ------------------------------------------------------------------------------

describe("Yahoo spark", () => {
  it("one request per call; the bodies read like a chart", async () => {
    const requests: SeenRequest[] = [];
    const body = sparkBody(
      sparkEntry("VWCE.DE", "EUR", closes("2026-09-28", "2026-10-02", 172.86)),
      sparkEntry("AAPL", "USD", closes("2026-09-28", "2026-10-02", 334.35)),
    );
    const yahoo = yahooOver(requests, () => respond(body));

    const bodies = await yahoo.spark(["AAPL", "VWCE.DE", "NOSUCH"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/v7/finance/spark");
    expect(requests[0]?.url.searchParams.get("symbols")).toBe("AAPL,VWCE.DE,NOSUCH");
    expect(requests[0]?.url.searchParams.get("interval")).toBe("1d");
    expect(new Set(bodies.keys())).toEqual(new Set(["VWCE.DE", "AAPL"])); // an unknown symbol is simply absent
    const history = yahoo.parseHistory(
      bodies.get("VWCE.DE") as string,
      vwce(),
      "2026-10-01",
      "2026-10-02",
    );
    expect(history.bars.map((b) => b.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(history.bars.at(-1)?.close.toString()).toBe("172.86");
    expect(history.bars.at(-1)?.open).toBeNull();
    expect(history.currency).toBe(Currencies.EUR);
  });

  it("blocked and errors", async () => {
    const yahoo = yahooOver([], () => respond("denied", 403));
    await expect(yahoo.spark(["AAPL"])).rejects.toBeInstanceOf(m.SourceBlockedException);
    expect(await yahoo.spark([])).toEqual(new Map());
    await expect(yahooOver([], () => respond("busy", 404)).spark(["AAPL"])).rejects.toThrow(
      "HTTP 404",
    );
    await expect(yahooOver([], () => respond("<html>")).spark(["AAPL"])).rejects.toThrow(
      "unexpected spark response",
    );
  });
});

// --- NBP tables -------------------------------------------------------------------------------

function nbpTables(days: string[], rates: Record<string, string>): string {
  const entries = Object.entries(rates)
    .map(([code, value]) => `{"currency":"${code.toLowerCase()}","code":"${code}","mid":${value}}`)
    .join(",");
  return `[${days
    .map(
      (on, i) =>
        `{"table":"A","no":"${i + 1}/A/NBP/2026","effectiveDate":"${on}","rates":[${entries}]}`,
    )
    .join(",")}]`;
}

describe("NBP tables", () => {
  it("table rates: one request for every currency", async () => {
    const requests: SeenRequest[] = [];
    const days = ["2026-10-01", "2026-10-02"];
    const body = nbpTables(days, { USD: "3.6512", EUR: "4.2701", XDR: "5.0" });
    const nbp = new NbpFxSource(makeHttp(recording(requests, () => respond(body))), {
      clock: fakeClock,
    });

    const rates = await nbp.tableRates("2026-10-01", "2026-10-02");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/api/exchangerates/tables/A/2026-10-01/2026-10-02/");
    expect(rates.get(Currencies.USD)?.map((r) => r.rate.toString())).toEqual(["3.6512", "3.6512"]);
    expect(rates.get(Currencies.EUR)?.[0]?.date).toBe("2026-10-01");
    expect(rates.get(toCurrency("XDR"))?.[0]?.rate.toString()).toBe("5.0"); // exact text, never a float
    const empty = new NbpFxSource(makeHttp(recording([], () => respond("Brak danych", 404))), {
      clock: fakeClock,
    });
    expect(await empty.tableRates("2026-10-03", "2026-10-04")).toEqual(new Map());
  });

  it("a table range longer than one request is refused", async () => {
    const nbp = new NbpFxSource(makeHttp(recording([], () => respond("[]"))), { clock: fakeClock });
    await expect(nbp.tableRates("2026-01-01", "2026-12-31")).rejects.toThrow(
      "max_days_per_request",
    );
  });
});

// --- BatchedPriceSource -----------------------------------------------------------------------

function batched(
  handler: Handler,
  fallback: m.PriceSource = new Fallback(),
  options: m.BatchedPriceSourceOptions = {},
) {
  const requests: SeenRequest[] = [];
  return {
    source: new m.BatchedPriceSource(yahooOver(requests, handler), fallback, options),
    requests,
  };
}

describe("BatchedPriceSource", () => {
  it("chunks of twenty symbols, answers from the batch", async () => {
    const stocks = Array.from({ length: 25 }, (_, n) => usStock(`S${String(n).padStart(2, "0")}`));
    const handler: Handler = (request) => {
      const symbols = (request.url.searchParams.get("symbols") ?? "").split(",");
      return respond(
        sparkBody(
          ...symbols.map((s) => sparkEntry(s, "USD", closes("2026-09-07", "2026-10-02", 10.5))),
        ),
      );
    };
    const fallback = new Fallback();
    const { source, requests } = batched(handler, fallback);
    await source.prefetch(stocks);

    expect(requests).toHaveLength(2); // 20 + 5
    const answer = await source.fetch(stocks[3] as Instrument, "2026-10-01", "2026-10-02");
    expect(answer.bars.map((b) => b.close.toString())).toEqual(["10.5", "10.5"]);
    expect(answer.bars.every((b) => b.source === "yahoo")).toBe(true);
    expect(fallback.calls).toEqual([]);
    expect(source.batched).toBe(1);
  });

  it("falls back when the batch cannot answer", async () => {
    const [aapl, euroListed, nosuch] = [usStock("AAPL"), usStock("EUR1"), usStock("NOSUCH")];
    const pkn = orlen(); // XWAR: stooq first, never batched
    const handler: Handler = () =>
      respond(
        sparkBody(
          sparkEntry("AAPL", "USD", closes("2026-09-21", "2026-10-02", 330.0)),
          sparkEntry("EUR1", "EUR", closes("2026-09-21", "2026-10-02", 9.0)),
        ),
      );
    const fallback = new Fallback();
    const { source, requests } = batched(handler, fallback);
    await source.prefetch([aapl, euroListed, nosuch, pkn] as Instrument[]);
    expect(requests[0]?.url.searchParams.get("symbols")).toBe("AAPL,EUR1,NOSUCH,PKN.WA"); // one request for all

    await source.fetch(aapl as Instrument, "2026-09-01", "2026-10-02"); // older than the batch window
    await source.fetch(euroListed as Instrument, "2026-10-01", "2026-10-02"); // currency mismatch
    await source.fetch(nosuch as Instrument, "2026-10-01", "2026-10-02"); // Yahoo left it out
    await source.fetch(pkn, "2026-10-01", "2026-10-02"); // stooq-first listing
    expect(fallback.calls.map((c) => c[0])).toEqual(["AAPL", "EUR1", "NOSUCH", "PKN"]);
    expect([source.batched, source.fallbacks]).toEqual([0, 4]);
  });

  it("the split guard sends an adjusted history the per-instrument way", async () => {
    const aapl = usStock("AAPL");
    const msft = usStock("MSFT");
    const body = sparkBody(
      sparkEntry("AAPL", "USD", closes("2026-09-21", "2026-10-02", 25.0)), // 4:1 split
      sparkEntry("MSFT", "USD", closes("2026-09-21", "2026-10-02", 101.0)),
    );
    const fallback = new Fallback();
    const { source } = batched(() => respond(body), fallback, {
      lastCloses: new Map([
        [aapl.id, ["2026-09-30", D("100")] as const],
        [msft.id, ["2026-09-30", D("100")] as const],
      ]),
    });
    await source.prefetch([aapl, msft]);
    await source.fetch(aapl, "2026-09-30", "2026-10-02");
    expect(
      (await source.fetch(msft, "2026-09-30", "2026-10-02")).bars.at(-1)?.close.toString(),
    ).toBe("101");
    expect(fallback.calls.map((c) => c[0])).toEqual(["AAPL"]);
  });

  it("a blocked spark stops batching", async () => {
    const stocks = Array.from({ length: 45 }, (_, n) => usStock(`S${String(n).padStart(2, "0")}`));
    const fallback = new Fallback();
    const { source, requests } = batched(() => respond("denied", 401), fallback);
    await source.prefetch(stocks);
    expect(requests).toHaveLength(1);
    expect(source.batchErrors.length).toBeGreaterThan(0);
    await source.fetch(stocks[0] as Instrument, "2026-10-01", "2026-10-02");
    expect(fallback.calls.length).toBeGreaterThan(0);
    expect(source.fallbacks).toBe(1);
  });

  it("a failed chunk only sends its own instruments to the fallback", async () => {
    const stocks = Array.from({ length: 25 }, (_, n) => usStock(`S${String(n).padStart(2, "0")}`));
    let calls = 0;
    const handler: Handler = (request) => {
      calls += 1;
      if (calls === 1) return respond("busy", 404);
      const symbols = (request.url.searchParams.get("symbols") ?? "").split(",");
      return respond(
        sparkBody(
          ...symbols.map((s) => sparkEntry(s, "USD", closes("2026-09-07", "2026-10-02", 10.5))),
        ),
      );
    };
    const fallback = new Fallback();
    const { source, requests } = batched(handler, fallback);
    await source.prefetch(stocks);
    expect(requests).toHaveLength(2);
    expect(source.batchErrors).toHaveLength(1);
    await source.fetch(stocks[0] as Instrument, "2026-10-01", "2026-10-02"); // first chunk failed
    await source.fetch(stocks[24] as Instrument, "2026-10-01", "2026-10-02"); // second chunk answered
    expect(fallback.calls.map((c) => c[0])).toEqual(["S00"]);
  });

  it("without yahoo everything goes per instrument", async () => {
    const fallback = new Fallback();
    const source = new m.BatchedPriceSource(null, fallback);
    await source.prefetch([usStock("AAPL")]);
    await source.fetch(usStock("AAPL"), "2026-10-01", "2026-10-02");
    expect(source.requests).toBe(0);
    expect(fallback.calls).toHaveLength(1);
  });

  it("chunk must be positive", () => {
    expect(() => new m.BatchedPriceSource(null, new Fallback(), { chunk: 0 })).toThrow(
      "chunk must be positive",
    );
  });
});

// --- BatchedFxSource --------------------------------------------------------------------------

class FallbackFx implements m.FxSource {
  readonly id = "nbp";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];
  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    this.calls.push([quote, start, end]);
    return [fxRate({ quote, date: end, rate: D("4"), source: "nbp" })];
  }
}

describe("BatchedFxSource", () => {
  it("fx from one table request within its window", async () => {
    const requests: SeenRequest[] = [];
    const body = nbpTables(["2026-09-30", "2026-10-01", "2026-10-02"], { USD: "3.6", EUR: "4.25" });
    const nbp = new NbpFxSource(makeHttp(recording(requests, () => respond(body))), {
      clock: fakeClock,
    });
    const fallback = new FallbackFx();
    const fx = new m.BatchedFxSource(nbp, fallback);
    await fx.prefetch("2026-09-30", "2026-10-02");

    const usd = await fx.rates(Currencies.USD, "2026-10-01", "2026-10-02");
    const eur = await fx.rates(Currencies.EUR, "2026-09-30", "2026-10-02");
    const chf = await fx.rates(toCurrency("CHF"), "2026-10-01", "2026-10-02"); // not in the table: none
    await fx.rates(Currencies.USD, "2026-09-01", "2026-10-02"); // older than the window

    expect(requests).toHaveLength(1);
    expect(usd.map((r) => r.rate.toString())).toEqual(["3.6", "3.6"]);
    expect(eur).toHaveLength(3);
    expect(chf).toEqual([]);
    expect(fallback.calls).toEqual([["USD", "2026-09-01", "2026-10-02"]]);
    expect(fx.id).toBe("nbp");
  });

  it("a failed table request leaves every currency to the fallback", async () => {
    const nbp = new NbpFxSource(makeHttp(recording([], () => respond("teapot", 418))), {
      clock: fakeClock,
    });
    const fallback = new FallbackFx();
    const fx = new m.BatchedFxSource(nbp, fallback);
    await fx.prefetch("2026-09-30", "2026-10-02");
    expect(fx.batchErrors[0]).toContain("HTTP 418");
    await fx.rates(Currencies.USD, "2026-10-01", "2026-10-02");
    expect(fallback.calls).toHaveLength(1);
  });
});

/** A composite stand-in whose stooq was blocked earlier in the run. */
class BlockedStooq extends Fallback implements m.BlockAwareSource {
  blocked(): ReadonlySet<string> {
    return new Set(["stooq"]);
  }
}

describe("stooq-first listings", () => {
  it("use the batch once stooq is blocked", async () => {
    const pkn = orlen();
    const body = sparkBody(sparkEntry("PKN.WA", "PLN", closes("2026-09-21", "2026-10-02", 61.0)));
    const fallback = new BlockedStooq();
    const { source } = batched(() => respond(body), fallback);
    await source.prefetch([pkn]);
    const answer = await source.fetch(pkn, "2026-10-01", "2026-10-02");
    expect(answer.bars.map((b) => b.close.toString())).toEqual(["61", "61"]);
    expect(fallback.calls).toEqual([]);
  });

  it("the first one probes stooq alone; the others wait and use the batch once it is blocked", async () => {
    const listings = [
      orlen(),
      orlen([instrumentAlias("stooq", "pzu"), instrumentAlias("yahoo", "PZU.WA")]),
    ];
    const body = sparkBody(
      sparkEntry("PKN.WA", "PLN", closes("2026-09-21", "2026-10-02", 61.0)),
      sparkEntry("PZU.WA", "PLN", closes("2026-09-21", "2026-10-02", 48.0)),
    );
    let stooqBlocked = false;
    let probes = 0;
    const composite: m.BlockAwareSource = {
      id: "composite",
      blocked: () => new Set(stooqBlocked ? ["stooq"] : []),
      async fetch() {
        probes += 1;
        await Promise.resolve();
        stooqBlocked = true; // the probe found stooq behind a bot check
        throw new m.SourceBlockedException("stooq", "browser verification page");
      },
    };
    const { source } = batched(() => respond(body), composite);
    await source.prefetch(listings);
    const results = await Promise.allSettled(
      listings.map((l) => source.fetch(l, "2026-10-01", "2026-10-02")),
    );
    expect(probes).toBe(1);
    expect(results[0]?.status).toBe("rejected");
    expect(
      results[1]?.status === "fulfilled" && results[1].value.bars.map((b) => b.close.toString()),
    ).toEqual(["48", "48"]);
    expect([source.fallbacks, source.batched]).toEqual([1, 1]);
  });
});
