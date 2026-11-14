// Composite price source: order, fallback, blocking, attribution
// (tests/investments/market/test_inv_composite_source.py; the recorded-response test is in @cashu/market).

import { describe, expect, it } from "vitest";
import { AssetClass } from "../domain/enums.js";
import { aliasOf, type Instrument, instrumentAlias } from "../domain/instrument.js";
import { type PriceBar, priceBar } from "../domain/marketData.js";
import { type CalendarDate, Currencies } from "../domain/values.js";
import { CompositePriceSource, sourceHealthJson } from "./composite.js";
import {
  NoPriceSourceException,
  type PriceHistory,
  type PriceSource,
  priceHistory,
  QuoteCurrencyMismatchException,
  SourceBlockedException,
  SourceException,
} from "./sources.js";
import { buildInstrument, d, FETCHED_AT, orlen, vwce } from "./testing/support.js";

const FROM = "2026-09-28";
const TO = "2026-10-02";

type Answer = (instrument: Instrument) => PriceBar[];

/** A scripted alias-based source: answers with bars, nothing, or throws. */
class FakeSource implements PriceSource {
  readonly calls: (string | null)[] = [];
  readonly id: string;
  readonly answer: Answer;
  constructor(id: string, answer: Answer) {
    this.id = id;
    this.answer = answer;
  }

  async fetch(
    instrument: Instrument,
    _start: CalendarDate,
    _end: CalendarDate,
  ): Promise<PriceHistory> {
    this.calls.push(aliasOf(instrument, this.id));
    return priceHistory({ bars: this.answer(instrument) });
  }
}

function barsFrom(source: string, target: Instrument): PriceBar[] {
  return [
    priceBar({
      instrumentId: target.id,
      date: "2026-10-02",
      close: d("10"),
      source,
      fetchedAt: FETCHED_AT,
    }),
  ];
}

const raises =
  (error: unknown): Answer =>
  () => {
    throw error;
  };

function setup(stooqAnswer?: Answer, yahooAnswer?: Answer) {
  const stooq = new FakeSource("stooq", stooqAnswer ?? ((i) => barsFrom("stooq", i)));
  const yahoo = new FakeSource("yahoo", yahooAnswer ?? ((i) => barsFrom("yahoo", i)));
  return { stooq, yahoo, composite: new CompositePriceSource([yahoo, stooq]) }; // list order must not matter
}

const firstSource = async (source: PriceSource, target: Instrument) =>
  (await source.fetch(target, FROM, TO)).bars[0]?.source;

describe("CompositePriceSource", () => {
  it("XWAR instruments ask stooq first and attribute the bars to it", async () => {
    const { stooq, yahoo, composite } = setup();
    expect(await firstSource(composite, orlen())).toBe("stooq");
    expect(stooq.calls).toEqual(["pkn"]);
    expect(yahoo.calls).toEqual([]);
    expect(composite.id).toBe("composite");
  });

  it("other instruments ask yahoo first", async () => {
    const { stooq, yahoo, composite } = setup();
    expect(await firstSource(composite, vwce())).toBe("yahoo");
    expect(yahoo.calls).toEqual(["VWCE.DE"]);
    expect(stooq.calls).toEqual([]);
  });

  it("a failing first source falls back to the next", async () => {
    const { stooq, yahoo, composite } = setup(
      raises(new SourceException("stooq", "HTTP 500", { retryable: true })),
    );
    expect(await firstSource(composite, orlen())).toBe("yahoo");
    expect(stooq.calls).toEqual(["pkn"]);
    expect(yahoo.calls).toEqual(["PKN.WA"]);
    expect(composite.health.get("stooq")?.failures).toBe(1);
    expect(composite.health.get("stooq")?.lastError).toBe("HTTP 500");
    expect(composite.health.get("yahoo")?.withData).toBe(1);
  });

  it("an empty first answer falls back to the next", async () => {
    const { composite } = setup(() => []);
    expect(await firstSource(composite, orlen())).toBe("yahoo");
    expect(composite.health.get("stooq")?.empty).toBe(1);
  });

  it("only sources with an alias are tried, and a guessed alias counts", async () => {
    const { stooq, composite } = setup();
    expect(await firstSource(composite, orlen([instrumentAlias("yahoo", "PKN.WA")]))).toBe("yahoo");
    expect(stooq.calls).toEqual([]);
    expect(await firstSource(composite, orlen([instrumentAlias("stooq", "pkn", true)]))).toBe(
      "stooq",
    );
  });

  it("a blocked source is skipped for the rest of the run", async () => {
    const { stooq, composite } = setup(
      raises(new SourceBlockedException("stooq", "browser verification page")),
    );
    await composite.fetch(orlen(), FROM, TO);
    const second = orlen([instrumentAlias("stooq", "pzu"), instrumentAlias("yahoo", "PZU.WA")]);
    expect(await firstSource(composite, second)).toBe("yahoo");
    expect(stooq.calls).toEqual(["pkn"]); // pzu never asked
    const health = composite.health.get("stooq");
    expect(health?.blocked).toBe(true);
    expect(health?.attempts).toBe(1);
    expect(composite.health.get("yahoo")?.attempts).toBe(2);
    expect(health && sourceHealthJson(health).blocked).toBe(true);
    expect([...composite.blocked()]).toEqual(["stooq"]);
  });

  it("when every source fails, one exception names each failure", async () => {
    const { composite } = setup(
      raises(new SourceException("stooq", "malformed CSV row 3")),
      raises(new SourceException("yahoo", "HTTP 503", { retryable: true })),
    );
    const error = (await composite
      .fetch(orlen(), FROM, TO)
      .catch((e: unknown) => e)) as SourceException;
    expect(error).toBeInstanceOf(SourceException);
    expect(error.sourceId).toBe("composite");
    expect(error.detail).toBe("stooq: malformed CSV row 3; yahoo: HTTP 503");
    expect(error.retryable).toBe(true);
  });

  it("an unexpected exception in one source does not hide the others", async () => {
    const { composite } = setup(raises(new RangeError("bug")));
    expect(await firstSource(composite, orlen())).toBe("yahoo");
    expect(composite.health.get("stooq")?.failures).toBe(1);
    expect(composite.health.get("stooq")?.lastError).toBe('RangeError("bug")');
  });

  it("no bars anywhere but one answered is an empty answer", async () => {
    const { composite } = setup(
      () => [],
      raises(new SourceException("yahoo", "HTTP 503", { retryable: true })),
    );
    expect((await composite.fetch(orlen(), FROM, TO)).bars).toEqual([]);
  });

  it("an instrument without any source alias throws NoPriceSource", async () => {
    const { stooq, yahoo, composite } = setup();
    const bond = buildInstrument({
      name: "EDO0136",
      symbol: "EDO0136",
      mic: null,
      assetClass: AssetClass.TREASURY_BOND,
    });
    await expect(composite.fetch(bond, FROM, TO)).rejects.toBeInstanceOf(NoPriceSourceException);
    expect([...stooq.calls, ...yahoo.calls]).toEqual([]);
  });

  it("a custom order is honoured", async () => {
    const stooq = new FakeSource("stooq", (i) => barsFrom("stooq", i));
    const yahoo = new FakeSource("yahoo", (i) => barsFrom("yahoo", i));
    const composite = new CompositePriceSource([stooq, yahoo], { order: () => ["yahoo"] });
    expect(await firstSource(composite, orlen())).toBe("yahoo");
  });

  it("a quote currency mismatch is reported even when another source answered empty (R3)", async () => {
    const mismatch = new QuoteCurrencyMismatchException(
      "yahoo",
      "quote currency GBP differs from the instrument currency USD",
      { quoteCurrency: Currencies.GBP, instrumentCurrency: Currencies.USD },
    );
    let { composite } = setup(() => [], raises(mismatch));
    const error = (await composite
      .fetch(vwce(), FROM, TO)
      .catch((e: unknown) => e)) as SourceException;
    expect(error.detail).toContain("yahoo: quote currency GBP");
    expect(error.retryable).toBe(false);

    // A plain failure next to an empty answer still means "no data in range".
    ({ composite } = setup(
      () => [],
      raises(new SourceException("yahoo", "HTTP 500", { retryable: true })),
    ));
    expect((await composite.fetch(vwce(), FROM, TO)).bars).toEqual([]);
  });
});
