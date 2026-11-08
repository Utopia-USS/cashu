// Adding to the watchlist: search picks verified against the chart, free text with its deterministic
// paths and the search fallback, warnings with stable codes, the network before the batch, verified
// bars into the price cache, one entry per instrument. Fake chart / search ports; synthetic data only.
import { addDays, D } from "@cashu/domain";
import {
  asInstrumentId,
  type CalendarDate,
  type Instrument,
  market,
  priceBar,
} from "@cashu/domain/investments";
import { exchangeForMic } from "@cashu/domain/investments/importing";
import { describe, expect, it } from "vitest";
import { storeWriter } from "../../command.js";
import { createInstrument } from "../commands/instruments.js";
import { applyRaw, raw, rawGid, type Vault, vault } from "../commands/testing/fixtures.js";
import { removeFromWatchlist } from "../commands/watchlist.js";
import { watchlist, watchlistItem } from "../queries/alerts.js";
import { loadInstrument, vaultInstrumentGids } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { addToWatchlistService } from "./testing/watchlistService.js";
import {
  cleanPick,
  type SearchPick,
  type WatchAddRequest,
  type WatchlistMarket,
} from "./watchlist.js";

const TODAY: CalendarDate = "2026-10-31";
const WORLD_ISIN = "IE00SYNTH001";

interface QuoteSpec {
  readonly currency: string;
  readonly type?: string;
  readonly longName?: string;
}

/** Chart answers of the synthetic listings (bars are built up to the asked end date). */
const CHARTS: Readonly<Record<string, QuoteSpec>> = {
  "WRLD.L": { currency: "USD", type: "ETF", longName: "Synthetic World UCITS ETF USD Acc" },
  "WRLD.DE": {
    currency: "EUR",
    type: "ETF",
    longName: "Synthetic World UCITS ETF USD Accumulation",
  },
  NVDX: { currency: "USD", type: "EQUITY", longName: "Nvdx Corporation" },
};

function quote(symbol: string, spec: QuoteSpec, end: CalendarDate): market.ChartQuote {
  const currency = spec.currency as market.ChartQuote["currency"];
  return {
    symbol,
    currency,
    instrumentType: spec.type ?? null,
    longName: spec.longName ?? null,
    exchangeName: null,
    bars: Array.from({ length: 250 }, (_, i) =>
      priceBar({
        instrumentId: asInstrumentId("chart"),
        date: addDays(end, i - 249),
        close: D(`${100 + i}.5`),
        source: "yahoo",
        currency,
      }),
    ),
    splits: [],
    adjusted: [],
  };
}

function hit(
  yahooSymbol: string,
  ticker: string,
  init: Partial<market.SearchHit> & { readonly mic?: string | null } = {},
): market.SearchHit {
  const mic = init.mic ?? null;
  return {
    yahooSymbol,
    ticker,
    name: `${ticker} listing`,
    quoteType: "EQUITY",
    assetClass: "equity",
    exchangeLabel: null,
    currencyHint: null,
    isin: null,
    source: "yahoo",
    market: mic === null ? null : exchangeForMic(mic),
    ...init,
    mic,
  };
}

/** Search answers by lower-case text. */
const SEARCHES: Readonly<Record<string, readonly market.SearchHit[]>> = {
  nvdx: [
    hit("NVDX", "NVDX", { mic: "XNAS", exchangeLabel: "NASDAQ" }),
    hit("NVDX.DE", "NVDX", { mic: "XETR", exchangeLabel: "XETRA" }),
  ],
  wrld: [
    hit("WRLD.DE", "WRLD", { mic: "XETR", exchangeLabel: "XETRA", assetClass: "etf" }),
    hit("WRLD.MI", "WRLD", { mic: "XMIL", exchangeLabel: "Milan", assetClass: "etf" }),
    hit("WRLD.AS", "WRLD", { mic: "XAMS", exchangeLabel: "Amsterdam", assetClass: "etf" }),
    hit("WRLD.MU", "WRLD", { exchangeLabel: "Munich", assetClass: "etf" }), // unknown market
  ],
  [WORLD_ISIN.toLowerCase()]: [
    hit("WRLD.L", "WRLD", {
      mic: "XLON",
      exchangeLabel: "LSE",
      assetClass: "etf",
      isin: WORLD_ISIN,
      name: "Synthetic World UCITS ETF USD Acc",
    }),
    hit("WRLD.DE", "WRLD", { mic: "XETR", source: "openfigi", isin: WORLD_ISIN }),
  ],
};

/** OpenFIGI's listings of the ISIN alone (Yahoo down). */
const FIGI_ONLY = [
  hit("WRLD.L", "WRLD", { mic: "XLON", exchangeLabel: "LSE", source: "openfigi" }),
  hit("WRLP.L", "WRLP", { mic: "XLON", exchangeLabel: "LSE", source: "openfigi" }),
  hit("WRLD.DE", "WRLD", { mic: "XETR", exchangeLabel: "XETRA", source: "openfigi" }),
];

interface FakeMarket extends WatchlistMarket {
  readonly charts: string[];
  readonly searches: string[];
  chartDown: boolean;
  searchDown: boolean;
  searchAnswers: Record<string, readonly market.SearchHit[]>;
  onChart?: (symbol: string) => void;
}

function fakeMarket(): FakeMarket {
  const fake: FakeMarket = {
    charts: [],
    searches: [],
    chartDown: false,
    searchDown: false,
    searchAnswers: { ...SEARCHES },
    async chart(symbol, start, end) {
      fake.charts.push(`${symbol} ${start} ${end}`);
      fake.onChart?.(symbol);
      if (fake.chartDown) throw new Error("offline");
      const spec = CHARTS[symbol];
      return spec === undefined ? null : quote(symbol, spec, end);
    },
    async search(text) {
      fake.searches.push(text);
      if (fake.searchDown) throw new Error("offline");
      return fake.searchAnswers[text.toLowerCase()] ?? [];
    },
  };
  return fake;
}

function setup() {
  const v = vault();
  const net = fakeMarket();
  const prices = new market.InMemoryPriceCache();
  const deps = { store: v.store, writer: storeWriter(v.store), env: v.env, market: net, prices };
  const read: Read = (sql, ...params) => v.store.read(sql, ...params);
  const add = (request: Omit<WatchAddRequest, "today"> & { today?: CalendarDate }) =>
    addToWatchlistService(deps, { today: TODAY, ...request });
  /** An add that must succeed. */
  const added = async (request: Omit<WatchAddRequest, "today"> & { today?: CalendarDate }) => {
    const out = await add(request);
    if (!out.ok) expect.fail(`add failed: ${out.reason}`);
    return out.value;
  };
  const instrument = (gid: string): Instrument => {
    const found = loadInstrument(read, gid, { shared: true });
    if (found === undefined) expect.fail("no instrument");
    return found;
  };
  const aliases = (gid: string) =>
    Object.fromEntries(instrument(gid).aliases.map((a) => [a.namespace, [a.value, a.guessed]]));
  const bars = (symbol: string) => prices.bars(market.marketSymbol("yahoo", symbol));
  const instrumentCount = () =>
    v.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_instruments")[0]?.n ?? 0;
  return { v, net, prices, read, add, added, instrument, aliases, bars, instrumentCount };
}

const pick = (yahooSymbol: string | null, rest: Omit<SearchPick, "yahooSymbol"> = {}) => ({
  target: { pick: { yahooSymbol, ...rest } },
});

const charted = (net: FakeMarket, symbol: string) =>
  net.charts.filter((c) => c.startsWith(`${symbol} `)).length;

function watchMany(v: Vault, count: number) {
  const events = [];
  for (let n = 1; n <= count; n++) {
    const gid = rawGid(7000 + n);
    events.push({
      type: "instrument.created",
      gid,
      data: {
        name: `Spolka ${n}`,
        currency: "PLN",
        assetClass: "equity",
        symbol: `S${n}`,
        isin: null,
        mic: null,
        region: null,
        sector: null,
        tags: [],
        needsClassification: false,
        valuationMode: "market",
        status: "active",
        creationAlias: null,
      },
    });
    events.push(raw.watchAdded(v, gid));
  }
  applyRaw(v, events);
}

describe("one entry per instrument through every add path", () => {
  it("remove keeps everything and every add path restores the same row", async () => {
    const t = setup();
    const first = await t.added({
      target: { text: "NEWCO.WA" },
      note: "moja notatka",
      tags: ["polska"],
    });
    expect(first).toMatchObject({ restored: false, createdInstrument: true });
    expect(first.warnings.map((w) => w.code)).toEqual([
      "watchlist.guessed_price_symbol",
      "watchlist.unverified_price_symbol",
    ]);
    const newco = first.instrument;
    t.v.value(removeFromWatchlist, { item: first.item });
    expect(watchlist(t.read)).toEqual([]);
    expect(vaultInstrumentGids(t.read).has(newco)).toBe(true);

    // by instrument: the same row, note and tags kept, source = this adder
    const again = await t.added({ target: { instrument: newco }, source: "agent" });
    expect(again).toMatchObject({ item: first.item, restored: true, createdInstrument: false });
    expect(again.warnings).toEqual([]);
    expect(watchlistItem(t.read, first.item)).toMatchObject({
      note: "moja notatka",
      tags: ["polska"],
      source: "agent",
    });
    expect(await t.add({ target: { instrument: newco } })).toEqual({
      ok: false,
      reason: "already_watched",
      params: { item: first.item },
    });

    // by free text (any case): tags passed -> replaced, note kept
    t.v.value(removeFromWatchlist, { item: first.item });
    const text = await t.added({ target: { text: "newco.wa" }, tags: ["nowe"] });
    expect(text).toMatchObject({ item: first.item, restored: true, note: "moja notatka" });
    expect(text.tags).toEqual(["nowe"]);

    // by search pick: the stored instrument by its (guessed) Yahoo alias, no network at all
    t.v.value(removeFromWatchlist, { item: first.item });
    const calls = t.net.charts.length + t.net.searches.length;
    const picked = await t.added({ ...pick("NEWCO.WA"), note: "nowa notatka" });
    expect(picked).toMatchObject({ item: first.item, restored: true, note: "nowa notatka" });
    expect(t.net.charts.length + t.net.searches.length).toBe(calls);
    expect(t.v.store.read("SELECT COUNT(*) AS n FROM watchlist_items")).toEqual([{ n: 1 }]);
  });

  it("a full watchlist or a bad note fails before any network", async () => {
    const t = setup();
    expect(await t.add({ ...pick("WRLD.L"), note: "x".repeat(1001) })).toMatchObject({
      ok: false,
      reason: "note_too_long",
    });
    watchMany(t.v, 200);
    expect(await t.add(pick("WRLD.L"))).toEqual({
      ok: false,
      reason: "watchlist_full",
      params: { max: 200 },
    });
    expect(t.net.charts).toEqual([]);
  });
});

describe("adding a search pick", () => {
  it("a verified pick takes the chart currency a confirmed alias and the bars", async () => {
    const t = setup();
    const added = await t.added(
      pick("WRLD.L", {
        ticker: "WRLD",
        name: "Synthetic World UCITS ETF USD Acc",
        assetClass: "etf",
        mic: "XLON",
        isin: WORLD_ISIN,
      }),
    );
    expect(added).toMatchObject({ createdInstrument: true, restored: false, warnings: [] });
    expect(t.instrument(added.instrument)).toMatchObject({
      symbol: "WRLD",
      mic: "XLON",
      currency: "USD",
      assetClass: "etf",
      isin: WORLD_ISIN,
      needsClassification: false,
    });
    expect(t.aliases(added.instrument)).toEqual({
      yahoo: ["WRLD.L", false],
      stooq: ["wrld.uk", true],
      isin: [WORLD_ISIN, false],
    });
    expect(t.bars("WRLD.L").length).toBeGreaterThan(200); // price and sparkline at once
    expect(t.bars("WRLD.L")[0]?.currency).toBe("USD");
    expect(charted(t.net, "WRLD.L")).toBe(1);

    // another listing of the same ISIN: created without the ISIN, never an error
    const other = await t.added(pick("WRLD.DE", { isin: WORLD_ISIN }));
    expect(t.instrument(other.instrument)).toMatchObject({
      symbol: "WRLD",
      mic: "XETR",
      currency: "EUR",
      isin: null,
      name: "Synthetic World UCITS ETF USD Accumulation", // chart longName
      assetClass: "etf", // from the chart instrumentType
    });
    expect(t.aliases(other.instrument).isin).toBeUndefined();

    // a stored listing (any case) is used as is: no second chart request
    t.v.value(removeFromWatchlist, { item: other.item });
    const again = await t.added(pick("wrld.de"));
    expect(again).toMatchObject({ item: other.item, restored: true });
    expect(charted(t.net, "WRLD.DE")).toBe(1);
  });

  it("an unverified pick keeps a guessed alias and warns", async () => {
    const t = setup();
    t.net.chartDown = true;
    const added = await t.added(
      pick("ORLX.WA", { ticker: "ORLX", name: "Orlix S.A.", assetClass: "equity" }),
    );
    expect(added.createdInstrument).toBe(true);
    expect(added.warnings).toEqual([
      { code: "watchlist.unverified_price_symbol", params: { symbol: "ORLX.WA" } },
    ]);
    expect(t.instrument(added.instrument)).toMatchObject({
      symbol: "ORLX",
      mic: "XWAR",
      currency: "PLN",
      name: "Orlix S.A.",
    });
    expect(t.aliases(added.instrument).yahoo).toEqual(["ORLX.WA", true]);
    expect(t.bars("ORLX.WA")).toEqual([]);
    const coin = await t.added(
      pick("SYNC-USD", { ticker: "SYNC", name: "Synccoin USD", assetClass: "crypto" }),
    );
    expect(t.instrument(coin.instrument)).toMatchObject({
      symbol: "SYNC",
      mic: null,
      currency: "USD",
      assetClass: "crypto",
      needsClassification: false,
    });
    // an unknown suffix without a chart: no currency can be told, nothing is created
    const before = t.instrumentCount();
    expect(await t.add(pick("WRLD.MU"))).toEqual({
      ok: false,
      reason: "unknown_currency",
      params: { symbol: "WRLD.MU" },
    });
    expect(t.instrumentCount()).toBe(before);
    // an unknown symbol (the chart answers nothing) is unverified too
    t.net.chartDown = false;
    const nope = await t.added(pick("NOPE.DE", { name: "Nope AG" }));
    expect(nope.warnings.map((w) => w.code)).toEqual(["watchlist.unverified_price_symbol"]);
  });

  it("pick input is validated", async () => {
    const t = setup();
    const cases: [SearchPick, string][] = [
      [{ yahooSymbol: "a b" }, "pick_symbol_invalid"],
      [{ yahooSymbol: "WRLD.DE", assetClass: "stock" }, "unknown_asset_class"],
      [{ yahooSymbol: "WRLD.DE", mic: "XMARS" }, "unknown_market"],
      [{ yahooSymbol: "WRLD.DE", isin: "IE00" }, "pick_isin_invalid"],
      [{ yahooSymbol: "WRLD.DE", ticker: "a b" }, "pick_ticker_invalid"],
    ];
    for (const [p, reason] of cases) {
      expect(await t.add({ target: { pick: p } }), reason).toMatchObject({ ok: false, reason });
    }
    expect(t.net.charts).toEqual([]);
  });

  it("today is used for the pick window", async () => {
    const t = setup();
    const today = "2026-06-01";
    await t.added({ ...pick("WRLD.DE"), today });
    expect(t.net.charts).toEqual([`WRLD.DE ${addDays(today, -366)} ${today}`]);
    const dates = t.bars("WRLD.DE").map((b) => b.date);
    expect(dates.every((d) => d <= today)).toBe(true);
  });

  it("pick symbols with class shares and ampersands", async () => {
    const cleaned = cleanPick({ yahooSymbol: "m&m.ns", ticker: "M&M" });
    expect(cleaned.ok && [cleaned.value.yahooSymbol, cleaned.value.ticker]).toEqual([
      "M&M.NS",
      "M&M",
    ]);
    const t = setup();
    t.net.chartDown = true;
    const cls = await t.added(pick("ABC-B", { ticker: "ABC/B", assetClass: "equity" }));
    expect(t.instrument(cls.instrument)).toMatchObject({ symbol: "ABC/B", currency: "USD" });
    expect(t.aliases(cls.instrument).yahoo).toEqual(["ABC-B", true]);
  });

  it("a concurrent pick of the same listing reuses the other instrument", async () => {
    const t = setup();
    let rival = "";
    // another tab stores the same listing while this add waits on the chart
    t.net.onChart = () => {
      rival = t.v.value(createInstrument, {
        name: "Rival",
        currency: "USD",
        assetClass: "etf",
        symbol: "WRLD",
        aliases: [{ namespace: "yahoo", value: "WRLD.L" }],
      }).gid;
    };
    const before = t.instrumentCount();
    const added = await t.added(pick("WRLD.L"));
    expect(added).toMatchObject({ instrument: rival, createdInstrument: false, warnings: [] });
    expect(t.instrumentCount()).toBe(before + 1); // only the rival
    expect(t.bars("WRLD.L")).toEqual([]);
  });
});

describe("free text", () => {
  it("free text asks the search only where it fails today", async () => {
    const t = setup();
    const nvdx = await t.added({ target: { text: "NVDX" } });
    expect(t.instrument(nvdx.instrument)).toMatchObject({
      symbol: "NVDX",
      mic: "XNAS",
      currency: "USD",
    });
    expect(t.aliases(nvdx.instrument).yahoo).toEqual(["NVDX", false]);
    expect(await t.add({ target: { text: "WRLD" } })).toEqual({
      ok: false,
      reason: "several_listings",
      params: {
        text: "WRLD",
        candidates: [
          { symbol: "WRLD.DE", exchange: "XETRA" },
          { symbol: "WRLD.MI", exchange: "Milan" },
          { symbol: "WRLD.AS", exchange: "Amsterdam" },
        ],
        more: 0,
      },
    });
    // an unknown ISIN without currency: one listing on a known market
    const world = await t.added({ target: { text: WORLD_ISIN } });
    expect(t.instrument(world.instrument)).toMatchObject({
      symbol: "WRLD",
      currency: "USD",
      isin: WORLD_ISIN,
    });
    // deterministic paths never search
    const searched = t.net.searches.length;
    await t.added({ target: { text: "PKX.WA" } });
    await t.added({ target: { text: "MSFX", exchange: "nasdaq" } });
    expect(t.net.searches.length).toBe(searched);
  });

  it("free text without search keeps the old errors", async () => {
    const t = setup();
    t.net.searchDown = true;
    expect(await t.add({ target: { text: "NVDX" } })).toEqual({
      ok: false,
      reason: "unknown_market",
      params: { text: "NVDX", ticker: "NVDX" },
    });
    expect(await t.add({ target: { text: WORLD_ISIN } })).toEqual({
      ok: false,
      reason: "unknown_isin",
      params: { isin: WORLD_ISIN },
    });
    // Yahoo down, OpenFIGI up: an ISIN with several listings names them
    t.net.searchDown = false;
    t.net.searchAnswers[WORLD_ISIN.toLowerCase()] = FIGI_ONLY;
    const several = await t.add({ target: { text: WORLD_ISIN } });
    expect(several.ok === false && several.params.candidates).toEqual([
      { symbol: "WRLD.L", exchange: "LSE" },
      { symbol: "WRLP.L", exchange: "LSE" },
      { symbol: "WRLD.DE", exchange: "XETRA" },
    ]);
    expect(await t.add({ target: { text: "ZZZZ" } })).toMatchObject({
      ok: false,
      reason: "unknown_market",
    }); // nothing found
  });

  it("a typed symbol with its market is verified like a pick", async () => {
    const t = setup();
    const added = await t.added({ target: { text: "WRLD.L" } });
    expect(added).toMatchObject({ createdInstrument: true, warnings: [] });
    expect(t.instrument(added.instrument)).toMatchObject({
      symbol: "WRLD",
      mic: "XLON",
      currency: "USD",
      assetClass: "etf",
      needsClassification: false,
    });
    expect(t.aliases(added.instrument).yahoo).toEqual(["WRLD.L", false]);
    expect(t.bars("WRLD.L").length).toBeGreaterThan(200);
    expect(t.net.searches).toEqual([]); // no search needed
    // verification fails: the guessed path (market currency) plus the unverified warning
    t.net.chartDown = true;
    const guessed = await t.added({ target: { text: "GDXX.L" } });
    expect(guessed.warnings).toEqual([
      {
        code: "watchlist.guessed_price_symbol",
        params: { symbol: "GDXX", currency: "GBP", price_symbol: "GDXX.L" },
      },
      { code: "watchlist.unverified_price_symbol", params: { symbol: "GDXX.L" } },
    ]);
    expect(t.instrument(guessed.instrument).currency).toBe("GBP");
    expect(t.aliases(guessed.instrument).yahoo).toEqual(["GDXX.L", true]);
    // an explicit currency keeps the deterministic path (no chart request)
    t.net.chartDown = false;
    const charts = t.net.charts.length;
    await t.added({ target: { text: "WRLD.MI", currency: "EUR" } });
    expect(t.net.charts.length).toBe(charts);
  });

  it("free text input is validated before any lookup", async () => {
    const t = setup();
    const cases: [Record<string, string | null>, string][] = [
      [{ text: null }, "symbol_required"],
      [{ text: "  " }, "symbol_required"],
      [{ text: "a b" }, "symbol_invalid"],
      [{ text: "NEW.WA", name: "n".repeat(121) }, "name_too_long"],
      [{ text: "NEW.WA", currency: "EURO" }, "currency_invalid"],
      [{ text: "NEW", exchange: "MARS" }, "unknown_exchange"],
    ];
    for (const [target, reason] of cases) {
      expect(await t.add({ target: target as { text: string | null } }), reason).toMatchObject({
        ok: false,
        reason,
      });
    }
    // an ISIN with its currency: a new instrument with no price symbol
    const isin = await t.added({ target: { text: "PL0000000999", currency: "pln", name: "Nowa" } });
    expect(isin.warnings).toEqual([
      { code: "watchlist.no_price_symbol", params: { isin: "PL0000000999" } },
    ]);
    expect(t.instrument(isin.instrument)).toMatchObject({
      name: "Nowa",
      currency: "PLN",
      needsClassification: true,
    });
    expect(t.net.charts).toEqual([]);
  });
});
