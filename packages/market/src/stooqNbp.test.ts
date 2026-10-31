// Stooq CSV source (bot-check detection) and NBP FX source (chunking, 404 = no data)
// (tests/investments/market/test_inv_stooq_nbp_sources.py).

import { addDays, daysBetween } from "@cashu/domain";
import {
  Currencies,
  fxRate,
  instrumentAlias,
  market as m,
  priceBar,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { NbpFxSource, StooqPriceSource } from "./sources.js";
import {
  d,
  FETCHED_AT,
  fakeClock,
  fixture,
  type Handler,
  makeHttp,
  orlen,
  recording,
  respond,
  type SeenRequest,
} from "./testing/support.js";

const FROM = "2026-09-14";
const TO = "2026-09-25";

class Stooq {
  readonly requests: SeenRequest[] = [];
  readonly source: StooqPriceSource;
  constructor(body: string, status = 200, contentType = "text/csv") {
    this.source = new StooqPriceSource(
      makeHttp(recording(this.requests, () => respond(body, status, contentType))),
      {
        clock: fakeClock,
      },
    );
  }
}

async function stooqFailure(stooq: Stooq, instrument = orlen()): Promise<m.SourceException> {
  const error = await stooq.source.fetch(instrument, FROM, TO).catch((e: unknown) => e);
  if (error instanceof m.SourceException) return error;
  throw new Error(`expected a SourceException, got ${String(error)}`);
}

const dates = (items: readonly { date: string }[]) => items.map((i) => i.date);

describe("stooq", () => {
  it("parses the Polish CSV and asks for alias and range", async () => {
    const pkn = orlen();
    const stooq = new Stooq(fixture("stooq_pkn_synthetic.csv"));
    const bars = (await stooq.source.fetch(pkn, FROM, TO)).bars;

    const url = stooq.requests[0]?.url as URL;
    expect(url.hostname).toBe("stooq.pl");
    expect(url.pathname).toBe("/q/d/l/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      s: "pkn",
      i: "d",
      d1: "20260914",
      d2: "20260925",
    });
    expect(dates(bars)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(bars[0]).toEqual(
      priceBar({
        instrumentId: pkn.id,
        date: "2026-09-14",
        open: d("64.12"),
        high: d("65.3"),
        low: d("63.9"),
        close: d("65.08"),
        volume: 2154321,
        source: "stooq",
        fetchedAt: FETCHED_AT,
      }),
    );
    expect(bars.at(-1)?.close.eq(d("65.36"))).toBe(true);
  });

  it("keeps only bars inside the range, oldest first", async () => {
    const bars = (
      await new Stooq(fixture("stooq_pkn_synthetic.csv")).source.fetch(
        orlen(),
        "2026-09-15",
        "2026-09-16",
      )
    ).bars;
    expect(dates(bars)).toEqual(["2026-09-15", "2026-09-16"]);
  });

  it("parses English headers without a volume column", async () => {
    const index = orlen([instrumentAlias("stooq", "wig20")]);
    const bars = (
      await new Stooq(fixture("stooq_index_no_volume_synthetic.csv")).source.fetch(index, FROM, TO)
    ).bars;
    expect(bars).toHaveLength(2);
    expect(bars[0]?.close.eq(d("2428.73"))).toBe(true);
    expect(bars[0]?.volume).toBeNull();
  });

  it("ignores a byte order mark", async () => {
    const body = `﻿${fixture("stooq_pkn_synthetic.csv")}`;
    const stooq = new Stooq(body, 200, "text/csv; charset=utf-8");
    expect((await stooq.source.fetch(orlen(), FROM, TO)).bars).toHaveLength(4);
  });

  it("'Brak danych' is an empty answer", async () => {
    expect(
      (
        await new Stooq(fixture("stooq_no_data.txt")).source.fetch(
          orlen(),
          "2026-09-19",
          "2026-09-20",
        )
      ).bars,
    ).toEqual([]);
    expect(
      (await new Stooq("No data").source.fetch(orlen(), "2026-09-19", "2026-09-20")).bars,
    ).toEqual([]);
  });

  it("a bot protection page is a non-retryable blocked exception", async () => {
    const error = await stooqFailure(
      new Stooq(fixture("stooq_challenge.html"), 200, "text/html; charset=utf-8"),
    );
    expect(error).toBeInstanceOf(m.SourceBlockedException);
    expect(error.retryable).toBe(false);
    expect(error.sourceId).toBe("stooq");
    expect(error.detail).toContain("browser verification");
  });

  it("the daily hit limit is a retryable blocked exception", async () => {
    const error = await stooqFailure(new Stooq(fixture("stooq_daily_limit.txt")));
    expect(error).toBeInstanceOf(m.SourceBlockedException);
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("daily request limit");
  });

  it("an API key demand is blocked", async () => {
    const error = await stooqFailure(
      new Stooq("Get your apikey:\n1. Open https://stooq.com/q/d/?s=pkn&get_apikey"),
    );
    expect(error).toBeInstanceOf(m.SourceBlockedException);
    expect(error.detail).toContain("API key");
  });

  it("another HTML page is a plain non-retryable SourceException", async () => {
    const error = await stooqFailure(new Stooq("<html><body>Strona w przebudowie</body></html>"));
    expect(error).not.toBeInstanceOf(m.SourceBlockedException);
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("HTML page");
  });

  it("unexpected text and malformed rows name the problem", async () => {
    expect((await stooqFailure(new Stooq("Symbol,Name\npkn,Orlen"))).detail).toContain(
      "unexpected response",
    );
    const malformed = await stooqFailure(
      new Stooq(
        "Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie,Wolumen\n2026-09-14,1,2,0.5,1.5,10\n2026-09-15,1,2,0.5,n/a,10",
      ),
    );
    expect(malformed.detail).toContain("malformed CSV row 3");
    expect(malformed.cause).toBeDefined();
    expect((await stooqFailure(new Stooq(""))).retryable).toBe(true);
  });

  it("a non-200 status is a SourceException", async () => {
    expect((await stooqFailure(new Stooq("gone", 410))).detail).toContain("HTTP 410");
  });

  it("an instrument without an alias cannot be priced and makes no request", async () => {
    const stooq = new Stooq(fixture("stooq_pkn_synthetic.csv"));
    const error = await stooqFailure(stooq, orlen([instrumentAlias("yahoo", "PKN.WA")]));
    expect(error).toBeInstanceOf(m.NoPriceSourceException);
    expect(stooq.requests).toEqual([]);
  });

  it("an empty range makes no request", async () => {
    const stooq = new Stooq(fixture("stooq_pkn_synthetic.csv"));
    expect((await stooq.source.fetch(orlen(), "2026-09-15", "2026-09-14")).bars).toEqual([]);
    expect(stooq.requests).toEqual([]);
  });
});

/** (start, end) of a path `/api/exchangerates/rates/A/<code>/<start>/<end>/`. */
function requestedRange(request: SeenRequest): [string, string] {
  const segments = request.url.pathname.split("/").filter(Boolean);
  return [segments.at(-2) as string, segments.at(-1) as string];
}

class Nbp {
  readonly requests: SeenRequest[] = [];
  readonly source: NbpFxSource;
  constructor(handler: Handler, maxDaysPerRequest = 93) {
    this.source = new NbpFxSource(makeHttp(recording(this.requests, handler)), {
      clock: fakeClock,
      maxDaysPerRequest,
    });
  }
}

describe("NBP", () => {
  it("parses the recorded USD response, PLN per USD", async () => {
    const nbp = new Nbp(() => respond(fixture("nbp_usd.json")));
    const rates = await nbp.source.rates(Currencies.USD, FROM, TO);

    const url = nbp.requests[0]?.url as URL;
    expect(url.hostname).toBe("api.nbp.pl");
    expect(url.pathname).toBe("/api/exchangerates/rates/A/usd/2026-09-14/2026-09-25/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ format: "json" });
    expect(dates(rates)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(rates[0]).toEqual(
      fxRate({
        quote: Currencies.USD,
        date: "2026-09-14",
        rate: d("3.7607"),
        source: "nbp",
        fetchedAt: FETCHED_AT,
      }),
    );
    expect(rates[0]?.base).toBe(Currencies.PLN);
    expect(rates.at(-1)?.rate.toString()).toBe("3.803"); // exact decimal text, never a float
  });

  it("parses the recorded EUR response with a Polish name", async () => {
    const rates = await new Nbp(() => respond(fixture("nbp_eur.json"))).source.rates(
      Currencies.EUR,
      FROM,
      TO,
    );
    expect(rates.map((r) => r.rate.toString())).toEqual(["4.3391", "4.3445", "4.3435", "4.3632"]);
    expect(rates.every((r) => r.quote === Currencies.EUR)).toBe(true);
  });

  it("a long range is split into contiguous requests of at most 93 days", async () => {
    const nbp = new Nbp((request) => {
      const [start, end] = requestedRange(request);
      if (start <= "2026-09-14" && end >= "2026-09-17") return respond(fixture("nbp_usd.json"));
      return respond(fixture("nbp_no_data_404.txt"), 404, "text/plain; charset=utf-8");
    });
    const rates = await nbp.source.rates(Currencies.USD, "2026-01-01", "2026-12-31");

    const ranges = nbp.requests.map(requestedRange);
    expect(ranges).toHaveLength(4); // 365 days / 93
    expect(ranges[0]?.[0]).toBe("2026-01-01");
    expect(ranges.at(-1)?.[1]).toBe("2026-12-31");
    ranges.forEach(([start, end], index) => {
      expect(daysBetween(start, end) + 1).toBeLessThanOrEqual(93);
      if (index > 0) expect(start).toBe(addDays((ranges[index - 1] as [string, string])[1], 1));
    });
    expect(rates).toHaveLength(4);
  });

  it("the chunk size is configurable", async () => {
    const nbp = new Nbp(() => respond(fixture("nbp_usd.json")), 367);
    await nbp.source.rates(Currencies.USD, "2025-09-01", "2026-10-03");
    expect(nbp.requests.map(requestedRange).map(([s, e]) => `${s}..${e}`)).toEqual([
      "2025-09-01..2026-09-02",
      "2026-09-03..2026-10-03",
    ]);
  });

  it("the recorded 404 for a range without tables is an empty answer", async () => {
    const nbp = new Nbp(() => respond(fixture("nbp_no_data_404.txt"), 404, "text/plain"));
    expect(await nbp.source.rates(Currencies.USD, "2026-09-19", "2026-09-20")).toEqual([]);
    expect(nbp.requests).toHaveLength(1); // not retried
  });

  it("the recorded 400 range limit is a non-retryable SourceException", async () => {
    const nbp = new Nbp(() => respond(fixture("nbp_range_limit_400.txt"), 400, "text/plain"));
    const error = (await nbp.source
      .rates(Currencies.USD, "2026-09-01", "2026-09-30")
      .catch((e: unknown) => e)) as m.SourceException;
    expect(error).toBeInstanceOf(m.SourceException);
    expect(error.sourceId).toBe("nbp");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("HTTP 400");
    expect(error.detail).toContain("367");
  });

  it("a response for another currency or of an unexpected shape is a SourceException", async () => {
    await expect(
      new Nbp(() => respond(fixture("nbp_eur.json"))).source.rates(Currencies.USD, FROM, TO),
    ).rejects.toThrow("rates for EUR");
    await expect(
      new Nbp(() => respond("<html>maintenance</html>", 200, "text/html")).source.rates(
        Currencies.USD,
        FROM,
        TO,
      ),
    ).rejects.toThrow("unexpected response");
  });

  it("5xx is retried by the shared HTTP helper", async () => {
    let calls = 0;
    const nbp = new Nbp(() => {
      calls += 1;
      return calls === 1 ? respond("busy", 503) : respond(fixture("nbp_usd.json"));
    });
    expect(await nbp.source.rates(Currencies.USD, FROM, TO)).toHaveLength(4);
    expect(nbp.requests).toHaveLength(2);
  });

  it("PLN and an empty range make no request", async () => {
    const nbp = new Nbp(() => respond(fixture("nbp_usd.json")));
    expect(await nbp.source.rates(Currencies.PLN, FROM, TO)).toEqual([]);
    expect(await nbp.source.rates(Currencies.USD, TO, FROM)).toEqual([]);
    expect(nbp.requests).toEqual([]);
  });
});
