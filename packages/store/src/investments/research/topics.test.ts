// The market view under a topic thesis (wording checks against price calls and advice, the agent's
// sourced quantitative outlook, the owner's edits and clears, the view surviving thesis edits and
// leaving notes alone), a snapshot-only crypto holding held at the start, watched-only topic rows and
// the review digest keeping this week's topics. Synthetic data only.
import { market } from "@cashu/domain/investments";
import * as research from "@cashu/domain/investments/research";
import { describe, expect, it } from "vitest";
import { setInstrumentSegment } from "../commands/instruments.js";
import {
  applyRaw,
  brokerage,
  raw,
  rawGid,
  stock,
  type Vault,
} from "../commands/testing/fixtures.js";
import { PerformanceService } from "../performance/service.js";
import { noBenchmarkStrategy } from "../performance/testing/household.js";
import { noteByGid, notes, topicThesis } from "./queries.js";
import { eventInstant } from "./rows.js";
import { segmentsView } from "./segments.js";
import {
  added,
  addNote,
  d,
  importTxn,
  investor,
  movingPortfolio,
  putBars,
  refusal,
  START,
  TODAY,
  watch,
  yahoo,
} from "./testing/fixtures.js";
import {
  proposeTopicDraft,
  saveTopicThesis,
  setTopicMarketView,
  topicThesisView,
} from "./topics.js";
import { notesView, researchDigest } from "./views.js";

const nowOf = (v: Vault) => eventInstant(new Date(v.env.clock.now()).toISOString());

const ASSESSMENT =
  "Adopcja robotów przemysłowych przyspiesza, ale wyceny sektora jako całości są wysokie.";
const OUTLOOK =
  "IFR szacuje wzrost instalacji robotów przemysłowych do ok. 575 tys. rocznie w 2028; " +
  "ryzykiem jest słabszy cykl inwestycyjny.";
const SOURCES = [
  {
    title: "World Robotics 2026",
    url: "https://example.org/p11/world-robotics",
    publisher: "Example Robotics Federation",
    published_at: "2026-09-24",
  },
];

describe("market view wording", () => {
  it.each([
    "Kup teraz, kurs wzrośnie do 100.",
    "Kurs NVDA wzrośnie w ciągu roku, bo popyt rośnie.",
    "Cel cenowy dla spółki to 200 USD w ciągu roku.",
    "Akcje spółek robotycznych mogą wzrosnąć o połowę.",
    "Notowania producentów odbiją w drugim półroczu.",
    "Cena docelowa ETF-u to 50 zł na koniec roku.",
    "The stock will double within two years of adoption.",
    "Sprzedaj przed wynikami, popyt słabnie w Chinach.",
    "S&P 500 wzrośnie do 7000 punktów w 2027.",
    "Wyceny spółek robotycznych spadną o połowę w 2 lata.",
    "Cena złota wzrośnie do 3000 USD w 2027.",
    "Fed prognozuje, że indeks Nasdaq zyska 20 % w 2027.",
    "The S&P 500 will reach 7000 by 2027.",
  ])("price calls and advice are warned about: %s", (wording) => {
    expect(research.marketViewProblem(wording)).toBe(true);
  });

  it.each([
    "Popyt na chipy do AI w najbliższych 12 miesiącach pozostanie silny.",
    "Ceny robotów spadną dzięki skali produkcji, co przyspieszy adopcję.",
    "Sprzedaż robotów rośnie, klienci kupują więcej systemów do magazynów.",
    "Wyceny sektora są wysokie, a adopcja dopiero przyspiesza.",
    "IEA szacuje, że popyt centrów danych na energię wzrośnie do ok. 945 TWh w 2030.",
    "IFR szacuje, że instalacje robotów wzrosną do 575 tys. rocznie w 2028.",
    "MFW prognozuje wzrost PKB USA o 2,1 % w 2027, co wspiera wydatki na automatyzację.",
    "Installations will reach 575,000 units a year by 2028 (IFR).",
  ])("market and adoption wording passes: %s", (wording) => {
    expect(research.marketViewProblem(wording)).toBe(false);
  });

  it.each([
    ["IFR szacuje 575 tys. instalacji rocznie w 2028.", true],
    ["SIA: sprzedaż chipów +19 % r/r w 2025, WSTS szacuje dalszy wzrost.", true],
    ["Gartner szacuje wydatki na IT na 5,6 bln USD w 2026.", true],
    ["W horyzoncie 2-4 lat oczekuję dalszego wzrostu wdrożeń do 2030 roku.", false],
    ["Popyt w Q3 pozostanie silny przez 12 mies.", false],
    ["Popyt na roboty rośnie, ryzykiem jest cykl.", false],
  ] as const)("the outlook estimate check ignores years and horizons: %s", (text, expected) => {
    expect(research.hasQuantitativeEstimate(text)).toBe(expected);
  });
});

/** The validation message of a refused view input (what the MCP layer shows). */
function problem(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof research.ResearchInputError) return e.message;
    throw e;
  }
  return "";
}

const view = (v: Vault, segment = "robotics") =>
  topicThesisView(topicThesis(v.store.read.bind(v.store), segment), "pl");

describe("the market view under a topic thesis", () => {
  it("agent writes the view under a thesis and the context reads it", () => {
    const { v } = investor();
    const input = {
      segment: "robotics",
      assessment: ASSESSMENT,
      outlook: OUTLOOK,
      sources: SOURCES,
    };
    expect(refusal(v.run(setTopicMarketView, input))).toBe("topic_needs_thesis");
    v.value(proposeTopicDraft, { segment: "robotics", thesis: "Robotyka to kolejna fala." });
    expect(v.value(setTopicMarketView, input).changed).toBe(true);
    let row = view(v);
    expect(row?.draft).toBe(true);
    expect(row?.assessment).toBe(ASSESSMENT);
    expect(row?.outlook).toBe(OUTLOOK);
    expect(row?.view_sources.map((s) => s.publisher)).toEqual(["Example Robotics Federation"]);
    expect(row?.view_updated_at).toBeTruthy();
    expect(row?.view_sources[0]?.url).toBe(SOURCES[0]?.url);
    expect(row?.view_sources[0]?.published_at).toBe("2026-09-24");
    // Price-call wording is a warning (the MCP layer reports it), never a refusal.
    expect(research.marketViewWarnings({ outlook: "Kurs akcji wzrośnie o 40%." })).toEqual([
      "outlook",
    ]);
    expect(problem(() => research.validateOutlook("Kurs akcji wzrośnie o 40%.", true))).toBe("");
    const vague = "Popyt na roboty rośnie, ryzykiem jest cykl.";
    expect(refusal(v.run(setTopicMarketView, { ...input, outlook: vague }))).toBe("invalid_view");
    expect(refusal(v.run(setTopicMarketView, { ...input, segment: "macro_risk" }))).toBe(
      "macro_segment",
    );
    row = view(v);
    expect(row?.outlook).toBe(OUTLOOK); // the refused write changed nothing
    expect(row?.thesis).toBe("Robotyka to kolejna fala.");
    expect(row?.draft).toBe(true);
  });

  it("the agent view needs a sourced quantitative outlook", () => {
    const { v } = investor();
    const now = nowOf(v);
    v.value(proposeTopicDraft, { segment: "robotics", thesis: "Robotyka to kolejna fala." });
    const input = { segment: "robotics", assessment: ASSESSMENT, outlook: OUTLOOK };
    expect(refusal(v.run(setTopicMarketView, input))).toBe("invalid_view");
    expect(problem(() => research.validateViewSources(undefined, now))).toContain("sources");
    const bad: [unknown, string][] = [
      [[], "at least one source"],
      [
        Array.from({ length: 7 }, (_, i) => ({
          ...SOURCES[0],
          url: `https://example.org/p11/${i}`,
        })),
        "at most 6",
      ],
      [[{ ...SOURCES[0], url: "ftp://example.org/x" }], "http(s)"],
      [[{ url: SOURCES[0]?.url, published_at: "2026-09-24" }], "publisher"],
      [[{ url: SOURCES[0]?.url, publisher: "Example" }], "published_at"],
    ];
    for (const [sources, needle] of bad) {
      expect(refusal(v.run(setTopicMarketView, { ...input, sources }))).toBe("invalid_view");
      expect(problem(() => research.validateViewSources(sources, now))).toContain(needle);
    }
    const vague = "W horyzoncie 2-4 lat oczekuję dalszego wzrostu wdrożeń do 2030 roku.";
    expect(refusal(v.run(setTopicMarketView, { ...input, sources: SOURCES, outlook: vague }))).toBe(
      "invalid_view",
    );
    expect(problem(() => research.validateOutlook(vague, true))).toBe(
      "outlook needs a sourced quantitative market or demand estimate (who, how much, horizon)",
    );
    const row = view(v);
    expect([row?.outlook, row?.view_sources]).toEqual([null, []]); // nothing was written
    v.value(setTopicMarketView, {
      ...input,
      sources: SOURCES,
      outlook:
        "MFW prognozuje wzrost PKB USA o 2,1 % w 2027, a IFR szacuje 575 tys. " +
        "instalacji robotów rocznie w 2028.",
    });
  });

  it("the view survives thesis edits and leaves notes alone", () => {
    const { v, read } = investor();
    const note = added(
      v,
      1,
      {
        kind: "trend",
        polarity: "positive",
        segment: "robotics",
        title: "Dostawy robotów rosną 1",
        summary: "Dostawy robotów przemysłowych wzrosły według danych branżowych.",
      },
      { instrument: null },
    ).note;
    // a legacy note-level copy (briefly allowed before P11) stays stored, never dropped
    const legacy = rawGid(901);
    applyRaw(v, [
      raw.noteAdded(legacy, null, {
        segment: "robotics",
        kind: "trend",
        title: "Stara notatka z oceną",
        details: { assessment: "stara ocena przy notatce", outlook: "stara perspektywa" },
        observedAt: `${TODAY}T08:00:00.000Z`,
      }),
    ]);
    v.value(saveTopicThesis, { segment: "robotics", thesis: "Robotyka to kolejna fala." });
    v.value(setTopicMarketView, {
      segment: "robotics",
      assessment: ASSESSMENT,
      outlook: OUTLOOK,
      sources: SOURCES,
    });
    v.value(saveTopicThesis, {
      segment: "robotics",
      thesis: "Robotyka to kolejna fala automatyzacji.",
    });
    const row = view(v);
    expect([row?.assessment, row?.outlook]).toEqual([ASSESSMENT, OUTLOOK]);
    expect(noteByGid(read, legacy)?.details?.assessment).toBeTruthy();
    const listed = notesView(read, notes(read, nowOf(v), { segment: "robotics" }), nowOf(v), "pl");
    for (const n of listed) expect("assessment" in (n.details ?? {})).toBe(false); // hidden
    expect(listed.map((n) => n.id)).toContain(note);
  });

  it("owner edits and clears the view", () => {
    const { v } = investor();
    const owner = { segment: "robotics", by: "owner" };
    expect(refusal(v.run(setTopicMarketView, { ...owner, assessment: ASSESSMENT }))).toBe(
      "topic_needs_thesis",
    );
    v.value(saveTopicThesis, { segment: "robotics", thesis: "Robotyka to kolejna fala." });
    v.value(setTopicMarketView, { ...owner, assessment: ASSESSMENT, outlook: OUTLOOK });
    let body = view(v);
    expect([body?.assessment, body?.outlook, body?.draft]).toEqual([ASSESSMENT, OUTLOOK, false]);
    expect(body?.view_updated_at).toBeTruthy();
    expect(body?.view_sources).toEqual([]);
    const cache = new market.InMemoryPriceCache();
    const computed = new PerformanceService().computed(v.store, {
      asOf: TODAY,
      strategy: noBenchmarkStrategy(),
      prices: cache,
    });
    const segments = segmentsView(v.store.read.bind(v.store), {
      computed,
      prices: cache,
      now: nowOf(v),
      lang: "pl",
    });
    const robotics = segments.ok
      ? segments.value.segments.find((r) => r.segment === "robotics")
      : undefined;
    expect((robotics?.thesis as { assessment: string } | null)?.assessment).toBe(ASSESSMENT);

    const vague = "Popyt na roboty rośnie, ryzykiem jest słabszy cykl inwestycyjny.";
    v.value(setTopicMarketView, { ...owner, outlook: vague, sources: SOURCES }); // no number needed
    expect(view(v)?.view_sources[0]?.publisher).toBe("Example Robotics Federation");
    v.value(setTopicMarketView, { ...owner, assessment: ASSESSMENT, outlook: OUTLOOK });
    expect(view(v)?.view_sources).toHaveLength(1); // left out: the stored sources stay
    expect(
      refusal(v.run(setTopicMarketView, { ...owner, outlook: OUTLOOK, sources: [{ url: "x" }] })),
    ).toBe("invalid_view");
    v.value(setTopicMarketView, {
      ...owner,
      assessment: ASSESSMENT,
      outlook: OUTLOOK,
      sources: null,
    });
    expect(view(v)?.view_sources).toEqual([]);
    v.value(setTopicMarketView, { ...owner, assessment: ASSESSMENT, sources: SOURCES });
    v.value(setTopicMarketView, { ...owner, assessment: ASSESSMENT, outlook: " " });
    body = view(v);
    expect([body?.assessment, body?.outlook]).toEqual([ASSESSMENT, null]);
    expect(body?.view_sources).toHaveLength(1);
    // The owner's own wording is never refused, price targets included.
    v.value(setTopicMarketView, { ...owner, assessment: "Cel cenowy 300 USD dla lidera sektora." });
    expect(view(v)?.assessment).toBe("Cel cenowy 300 USD dla lidera sektora.");
    v.value(setTopicMarketView, owner);
    body = view(v);
    expect([body?.assessment, body?.outlook, body?.view_updated_at]).toEqual([null, null, null]);
    expect(body?.view_sources).toEqual([]); // a cleared view keeps no sources
    expect(refusal(v.run(setTopicMarketView, { segment: "macro_risk", by: "owner" }))).toBe(
      "macro_segment",
    );
    expect(view(v)?.thesis).toBe("Robotyka to kolejna fala.");
  });
});

// ------------------------------------------------------------------ P7 topics

function segmentsOf(v: Vault, cache: market.PriceCache) {
  const computed = new PerformanceService().computed(v.store, {
    asOf: TODAY,
    strategy: noBenchmarkStrategy(),
    prices: cache,
  });
  const out = segmentsView(v.store.read.bind(v.store), {
    computed,
    prices: cache,
    now: nowOf(v),
    lang: "pl",
  });
  if (!out.ok) expect.fail(out.reason);
  return out.value;
}

/** 41 daily closes, `before` up to the window start, `after` from then on. */
function bars(
  cache: market.PriceCache,
  symbol: string,
  before: string,
  after: string,
  currency = "USD",
) {
  putBars(cache, symbol, TODAY, 40, (day) => (day <= START ? before : after), currency);
}

/** A watched US instrument (`<SYM>.US`). */
function watchUs(v: Vault, symbol: string, isin: string): string {
  const g = stock(v, symbol, isin, {
    currency: "USD",
    mic: "XNAS",
    aliases: [yahoo(`${symbol}.US`)],
  });
  watch(v, g);
  return g;
}

describe("topics", () => {
  it("a snapshot only crypto holding is held at the start", () => {
    const { v, cache } = movingPortfolio();
    // A crypto account whose only record is the corrected broker snapshot of 2 days ago (BTC 0.5).
    const crypto = brokerage(v, "Krypto");
    const btc = stock(v, "BTC", "XX0000000BTC", {
      name: "Bitcoin",
      currency: "USD",
      assetClass: "crypto",
      mic: null,
      aliases: [yahoo("BTC-USD")],
    });
    applyRaw(v, [
      importTxn(v, crypto, btc, {
        type: "adjustment",
        source: "reconciliation",
        tradeDate: d(2),
        quantity: "0.5",
        price: null,
        currency: "USD",
        cashCurrency: "USD",
        createdAt: `${d(2)}T00:00:00.000001Z`,
      }),
    ]);
    bars(cache, "BTC-USD", "60000", "66000");
    const out = segmentsOf(v, cache);
    const rows = new Map(out.segments.map((r) => [r.segment, r]));
    expect(out.new_positions).toBe(1); // XMPL bought mid-window; BTC is not new
    const row = rows.get("crypto");
    // T0 = 20 000 + 0.5 x 60 000 USD x 4.0 = 140 000; BTC +10 % in USD, USD flat
    expect(row?.weight).toBe(research.roundShare(120000 / 140000));
    expect(row?.contribution).toBe(research.roundShare(12000 / 140000));
    expect(row?.return).toBe(0.1);
    expect(row?.instruments.map((x) => x.instrument_id)).toEqual([btc]);
    expect([row?.trend_1w, row?.members]).toEqual([0.1, 1]);
    expect(out.segments[0]?.segment).toBe("crypto"); // the largest |contribution|
    expect(out.stale).not.toContain(btc);
  });

  it("watched only topics are rows after the exposed ones", () => {
    const { v, cache } = movingPortfolio();
    const ionq = watchUs(v, "IONQ", "US0000000IQ1");
    const rgti = watchUs(v, "RGTI", "US0000000RG1");
    const qbts = watchUs(v, "QBTS", "US0000000QB1");
    const oil = watchUs(v, "XOM", "US0000000XM1");
    for (const g of [ionq, rgti, qbts]) {
      v.value(setInstrumentSegment, { instrument: g, segment: "quantum", by: "owner" });
    }
    v.value(setInstrumentSegment, { instrument: oil, segment: "energy", by: "agent" });
    bars(cache, "IONQ.US", "10", "13"); // +30 %
    bars(cache, "RGTI.US", "10", "9"); // -10 %
    bars(cache, "XOM.US", "100", "101"); // +1 %
    const out = segmentsOf(v, cache);
    const order = out.segments.map((r) => r.segment);
    expect(order.slice(0, 3)).toEqual(["equity_pl", "equity_global", "bonds"]); // by |contribution|
    expect(order.slice(3)).toEqual(["quantum", "energy"]); // then |trend_1w|
    const quantum = out.segments[3];
    expect([quantum?.weight, quantum?.contribution, quantum?.return]).toEqual([0.0, 0.0, null]);
    expect(quantum?.trend_1w).toBe(0.1); // (+30 % - 10 %) / 2; QBTS has no bars
    expect(quantum?.members).toBe(2);
    expect(quantum?.instruments).toEqual([]);
    const members = new Map(quantum?.member_instruments.map((m) => [m.label, m]));
    expect(new Set(members.keys())).toEqual(new Set(["IONQ", "RGTI", "QBTS"]));
    expect(members.get("IONQ")?.held).toBe(false);
    expect(members.get("QBTS")?.return_1w).toBeNull();
    // a held topic with exposure gets the trend of its held members (equal weight)
    expect([out.segments[0]?.trend_1w, out.segments[0]?.members]).toEqual([0.1, 1]);
    expect(out.segments[2]?.trend_1w).toBeNull(); // a treasury bond at cost has no bars
  });

  it("the review digest keeps topics with a note this week", () => {
    const { v, cache } = movingPortfolio();
    const picks: [string, string, string][] = [
      ["IONQ", "US0000000IQ1", "quantum"],
      ["XOM", "US0000000XM1", "energy"],
      ["MP", "US0000000MP1", "metals"],
      ["MSFT", "US0000000MS1", "software"],
    ];
    picks.forEach(([symbol, isin, segment], n) => {
      const g = watchUs(v, symbol, isin);
      v.value(setInstrumentSegment, { instrument: g, segment, by: "owner" });
      bars(cache, `${symbol}.US`, "100", String(101 + n));
    });
    const note = addNote(v, 1, { kind: "macro", segment: "crypto" }, { instrument: null });
    expect(note.ok).toBe(true); // no exposure, no member: the last row of the view
    const segments = segmentsOf(v, cache);
    expect(segments.segments.at(-1)?.segment).toBe("crypto");
    const block = researchDigest(v.store.read.bind(v.store), {
      now: nowOf(v),
      since: nowOf(v) - 7n * research.MICROS_PER_DAY,
      segments: research.digestSegments(segments),
    });
    const order = (block.segments as research.SegmentRow[]).map((r) => r.segment);
    expect(order).toHaveLength(6);
    expect(order[0]).toBe("crypto"); // the new note first, then the view's order
    expect(order.slice(1)).toEqual(["equity_pl", "equity_global", "bonds", "software", "metals"]);
  });
});
