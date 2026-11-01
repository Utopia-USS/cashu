// Test-for-test translation of `tests/investments/persistence/test_p5_segments_service.py`: the
// segments view (shape, windows, residual, a note without exposure, the attribution with moving
// prices, FX, a cost holding, cash and a mid-window buy), segment notes (rules, signal key and
// payload), the weekly novelty limits, on-demand scopes, one segment note per week of storing and the
// review digest's segments. HTTP status codes become refusal codes. Synthetic data only. Each `it`
// names its Python test.
//
// Not translated: `test_patch_segment_auto_and_clear` (the instrument PATCH: the segment override
// command is S22d's `setInstrumentSegment`, the endpoint S36; `segment_of` / auto segments are
// covered by the domain's research/segments.test.ts).
import { addDays } from "@cashu/domain";
import { market, research } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { setInstrumentSegment } from "../commands/instruments.js";
import {
  applyRaw as applyRawEvents,
  brokerage as brokerageOf,
  stock,
  type Vault,
  vault,
} from "../commands/testing/fixtures.js";
import { PerformanceService } from "../performance/service.js";
import { noBenchmarkStrategy } from "../performance/testing/household.js";
import {
  dismissResearchNote,
  finishResearchRun,
  markResearchRead,
  startResearchRun,
} from "./commands.js";
import { notes, runByGid } from "./queries.js";
import { eventInstant } from "./rows.js";
import { segmentsView } from "./segments.js";
import {
  added,
  addNote,
  distinctWords,
  investor,
  putBars,
  putRates,
  refusal,
  researchSignals,
  TODAY,
  thesis,
  watch,
  yahoo,
} from "./testing/fixtures.js";
import { notesView, researchDigest, researchSummary } from "./views.js";

const nowOf = (v: Vault) => eventInstant(new Date(v.env.clock.now()).toISOString());

function view(v: Vault, cache: market.PriceCache, window = "1w") {
  const computed = new PerformanceService().computed(v.store, {
    asOf: TODAY,
    strategy: noBenchmarkStrategy(),
    prices: cache,
  });
  return segmentsView(v.store.read.bind(v.store), {
    computed,
    prices: cache,
    window,
    now: nowOf(v),
    lang: "pl",
  });
}

function viewValue(v: Vault, cache: market.PriceCache, window = "1w") {
  const out = view(v, cache, window);
  if (!out.ok) expect.fail(out.reason);
  return out.value;
}

/** Python `segment_note`: a market segment note (kind macro by default). */
function segmentNote(
  v: Vault,
  n: number,
  segment = "gold",
  changes: Record<string, unknown> = {},
  run: string | null = null,
) {
  return addNote(v, n, { kind: "macro", segment, ...changes }, { instrument: null, run });
}

function segmentNoted(
  v: Vault,
  n: number,
  segment = "gold",
  changes: Record<string, unknown> = {},
  run: string | null = null,
): string {
  const out = segmentNote(v, n, segment, changes, run);
  if (!out.ok) expect.fail(`segment note refused: ${out.reason}`);
  return out.value.note;
}

/** Flat prices for the investor's instruments over 40 days and flat EUR / USD rates. */
function flatPrices(): market.InMemoryPriceCache {
  const cache = new market.InMemoryPriceCache();
  putBars(cache, "ABC.WA", TODAY, 40, () => "60", "PLN");
  putBars(cache, "WRLD.DE", TODAY, 40, () => "110", "EUR");
  putBars(cache, "XMPL", TODAY, 40, () => "100", "USD");
  const days = Array.from({ length: 41 }, (_, i) => addDays(TODAY, i - 40));
  putRates(cache, "EUR", days, () => "4.3");
  putRates(cache, "USD", days, () => "4.0");
  return cache;
}

describe("GET /research/segments", () => {
  it("test_segments_endpoint_shape_windows_and_residual", () => {
    const i = investor();
    const { v } = i;
    v.value(setInstrumentSegment, { instrument: i.abc, segment: "equity_pl", by: "owner" });
    const empty = viewValue(v, new market.InMemoryPriceCache());
    expect(new Set(Object.keys(empty))).toEqual(
      new Set([
        "as_of",
        "start",
        "end",
        "window",
        "base_currency",
        "portfolio_return",
        "explained",
        "residual",
        "new_positions",
        "stale",
        "segments",
        "unassigned",
        "currency",
      ]),
    );
    // no prices at all: stale everywhere, the series is incomplete -> no residual
    expect(empty.portfolio_return).toBeNull();
    expect(empty.residual).toBeNull();
    expect(empty.window).toBe("1w");
    expect(empty.base_currency).toBe("PLN");
    expect(empty.start).toBe(addDays(empty.end, -7));
    const month = viewValue(v, new market.InMemoryPriceCache(), "4w");
    expect(month.start).toBe(addDays(empty.end, -28));
    const bad = view(v, new market.InMemoryPriceCache(), "2w");
    expect(bad.ok ? "" : bad.reason).toBe("unknown_window");

    const flat = viewValue(v, flatPrices());
    expect(flat.portfolio_return).toBe(0.0);
    expect(flat.residual).toBe(0.0);
    expect(flat.stale).toEqual([]);
    expect(flat.segments).toHaveLength(1);
    const [row] = flat.segments;
    expect(row?.segment).toBe("equity_pl");
    expect(row?.label).toBe("Akcje polskie");
    expect(row?.group).toBe("asset");
    expect(row?.weight).toBeGreaterThan(0);
    expect(row?.weight).toBeLessThan(1);
    expect(row?.contribution).toBe(0.0);
    expect(row?.instruments[0]?.instrument_id).toBe(i.abc);
    expect(row?.instruments[0]?.label).toBe("ABC");
    expect(row?.note).toBeNull();
    expect(row?.note_this_week).toBe(false);
    expect(row?.notes_8w).toBe(0);
    expect(new Set(flat.unassigned?.instruments.map((x) => x.label))).toEqual(
      new Set(["WRLD", "XMPL"]),
    );
    expect(flat.unassigned?.label).toBe("Bez tematu");
    expect(new Set(flat.currency.currencies.map((c) => c.currency))).toEqual(
      new Set(["EUR", "USD"]),
    );
    expect(flat.currency.contribution).toBe(0.0);
    expect(flat.explained).toBe(0.0);
  });

  it("test_segment_with_a_note_and_no_exposure_appears_and_reads", () => {
    const i = investor();
    const { v } = i;
    const cache = new market.InMemoryPriceCache();
    const note = segmentNoted(v, 1, "gold", { strength: 3 });
    let gold = viewValue(v, cache).segments.find((r) => r.segment === "gold");
    expect([gold?.weight, gold?.contribution, gold?.return]).toEqual([0.0, 0.0, null]);
    expect(gold?.note?.id).toBe(note);
    expect(gold?.note?.kind).toBe("macro");
    expect(gold?.note?.strength).toBe(3);
    expect(gold?.note_this_week).toBe(true);
    expect(gold?.unread).toBe(1);
    expect(gold?.notes_8w).toBe(1);
    expect(gold?.last_note_at).toBeTruthy();
    const summary = researchSummary(i.read, { now: nowOf(v), lang: "pl", weights: new Map() });
    expect("themes" in summary).toBe(false);
    expect(summary.totals.notes_unread).toBe(1);
    expect(v.value(markResearchRead, { segment: "gold" })).toEqual({ marked: 1 });
    expect(refusal(v.run(markResearchRead, { segment: "nope" }))).toBe("unknown_segment");
    gold = viewValue(v, cache).segments.find((r) => r.segment === "gold");
    expect(gold?.unread).toBe(0);
    // the notes list filter and the note dict
    const listed = notesView(i.read, notes(i.read, nowOf(v), { segment: "gold" }), nowOf(v), "pl");
    expect(listed.map((n) => n.id)).toEqual([note]);
    expect(listed[0]?.segment_label).toBe("Złoto i górnicy");
    expect(listed[0]?.instrument_id).toBeNull();
    expect(notes(i.read, nowOf(v), { segment: "energy" })).toEqual([]);
    // a dismissed note no longer shows as the segment's note (and the row goes without exposure)
    v.value(dismissResearchNote, { note });
    expect(viewValue(v, cache).segments.every((r) => r.segment !== "gold")).toBe(true);
  });
});

describe("segment notes", () => {
  it("test_segment_note_rules", () => {
    const i = investor();
    const { v } = i;
    expect(refusal(addNote(v, 1, { segment: "gold", kind: "macro" }))).toBe("segment_only");
    const first = segmentNoted(v, 2, "gold");
    expect(refusal(segmentNote(v, 3, "gold"))).toBe("segment_week");
    v.value(dismissResearchNote, { note: first });
    expect(refusal(segmentNote(v, 4, "gold"))).toBe("segment_week"); // dismissed ones count too
    segmentNoted(v, 5, "crypto", { kind: "trend" }); // another segment
    // last ISO week is a different week; the same title within 14 days is still a duplicate
    const lastWeek = addDays(TODAY, -8);
    segmentNoted(v, 6, "energy", { observed_at: lastWeek });
    const six = `Example fact number 6 ${distinctWords(6)}`;
    expect(refusal(segmentNote(v, 7, "energy", { title: six }))).toBe("duplicate");
    // the same title on another segment is not a duplicate (scope = the segment)
    segmentNoted(v, 8, "metals", { title: six });
    const rows = notes(i.read, nowOf(v), { segment: "energy", includeDismissed: true });
    expect(rows.map((r) => r.title)).toEqual([six]);
  });

  it("test_segment_note_signal_key_and_payload", () => {
    const i = investor();
    const note = segmentNoted(i.v, 1, "power", { strength: 3 });
    const sigs = researchSignals(i.v);
    expect(sigs).toHaveLength(1);
    const sig = sigs[0];
    expect(sig?.dedupKey.endsWith("|s:power")).toBe(true);
    expect(sig?.severity).toBe("info");
    expect(sig?.instrument).toBeNull();
    expect(sig?.payload.segment).toBe("power");
    expect(sig?.payload.segment_label).toBe("Energetyka: atom i OZE");
    expect(sig?.payload.note_id).toBe(note);
    expect(sig?.payload.theme).toBeNull();
  });
});

/** Four watched instruments W1..W4 (`W<n>.DE`). */
function watchFour(v: Vault): string[] {
  return [1, 2, 3, 4].map((n) => {
    const g = stock(v, `W${n}`, `DE000000000${n}`, {
      currency: "EUR",
      mic: "XETR",
      aliases: [yahoo(`W${n}.DE`)],
    });
    watch(v, g);
    return g;
  });
}

describe("novelty limits of the weekly run", () => {
  it("test_weekly_novelty_limits", () => {
    const i = investor();
    const { v } = i;
    const [, , , w4] = watchFour(v);
    thesis(v, w4 as string, "Teza");
    const run = v.value(startResearchRun, { scope: { scheduled: true } }).run;
    expect(
      research.validateScope({ scheduled: true }).held && runByGid(i.read, run)?.scope.held,
    ).toBe(true);
    ["ABC", "WRLD", "XMPL", "W1.DE", "W2.DE", "W3.DE"].forEach((ref, k) => {
      added(v, k + 1, {}, { instrument: ref, run });
    });
    expect(refusal(addNote(v, 10, {}, { instrument: "W4.DE", run }))).toBe("novelty_instruments");
    added(v, 11, { strength: 3 }, { instrument: "W4.DE", run }); // material: passes
    added(v, 12, { thesis_relation: "invalidates" }, { instrument: "W4.DE", run });
    // two notes per instrument, a third only when material
    added(v, 13, {}, { instrument: "ABC", run });
    expect(refusal(addNote(v, 14, {}, { instrument: "ABC", run }))).toBe("novelty_per_instrument");
    added(v, 15, { strength: 3 }, { instrument: "ABC", run });
    // six segment notes per week
    ["gold", "crypto", "bonds", "energy", "metals", "power"].forEach((segment, k) => {
      segmentNoted(v, 20 + k, segment, {}, run);
    });
    expect(refusal(segmentNote(v, 30, "healthcare", {}, run))).toBe("novelty_segments");
    v.value(finishResearchRun, { run });

    const onDemand = v.value(startResearchRun, {
      scope: { held: false, watchlist: false, candidates: false, instruments: ["ABC"] },
    }).run;
    expect(runByGid(i.read, onDemand)?.scope.held).toBe(false);
    for (const n of [40, 41, 42]) added(v, n, {}, { instrument: "ABC", run: onDemand }); // exempt
    segmentNoted(v, 43, "healthcare", {}, onDemand);
  });

  it("test_novelty_counts_per_week_over_weekly_runs_and_notes_without_a_run", () => {
    const i = investor();
    const { v } = i;
    watchFour(v);
    const first = v.value(startResearchRun, { scope: { scheduled: true } }).run;
    ["ABC", "WRLD", "XMPL", "W1.DE"].forEach((ref, k) => {
      added(v, k + 1, {}, { instrument: ref, run: first });
    });
    segmentNoted(v, 5, "gold", {}, first);
    v.value(finishResearchRun, { run: first });
    // a second weekly run in the same ISO week shares the budget
    const second = v.value(startResearchRun, {}).run;
    added(v, 6, {}, { instrument: "W2.DE", run: second });
    added(v, 7, {}, { instrument: "ABC", run: second }); // the 2nd ABC note this week
    expect(refusal(addNote(v, 8, {}, { instrument: "ABC", run: second }))).toBe(
      "novelty_per_instrument",
    );
    v.value(finishResearchRun, { run: second });
    // an agent note without a run counts and is limited
    added(v, 9, {}, { instrument: "W3.DE" }); // the 6th instrument
    expect(refusal(addNote(v, 10, {}, { instrument: "W4.DE" }))).toBe("novelty_instruments");
    added(v, 11, { strength: 3 }, { instrument: "W4.DE" }); // material: passes
    ["crypto", "bonds", "energy", "metals", "power"].forEach((segment, k) => {
      segmentNoted(v, 12 + k, segment);
    });
    expect(refusal(segmentNote(v, 20, "quantum"))).toBe("novelty_segments");
    // the owner's own notes are never limited
    added(v, 21, {}, { instrument: "ABC", createdBy: "user" });
  });

  it("test_scope_with_only_instruments_or_segments_is_on_demand", () => {
    const i = investor();
    const { v } = i;
    for (const raw of [{ instruments: ["ABC"] }, { segments: ["gold"] }]) {
      const scope = research.validateScope(raw);
      expect([scope.held, scope.watchlist, scope.candidates]).toEqual([false, false, false]);
    }
    expect(research.validateScope({ instruments: ["ABC"], held: true }).held).toBe(true);
    expect(research.validateScope({}).held).toBe(true);
    expect(research.validateScope({ themes: ["Banki"] }).held).toBe(true);
    const run = v.value(startResearchRun, { scope: { instruments: ["ABC"] } }).run;
    expect(runByGid(i.read, run)?.scope.held).toBe(false);
    for (const n of [1, 2, 3]) added(v, n, {}, { instrument: "ABC", run }); // exempt
  });

  it("test_one_segment_note_per_week_of_storing_too", () => {
    const i = investor();
    const { v } = i;
    segmentNoted(v, 1, "gold");
    const back = addDays(TODAY, -15);
    expect(refusal(segmentNote(v, 2, "gold", { observed_at: back }))).toBe("segment_week");
    segmentNoted(v, 3, "crypto", { observed_at: back }); // another segment is fine
  });
});

describe("review digest", () => {
  it("test_review_digest_carries_the_week_segments", () => {
    const i = investor();
    const { v } = i;
    const keys = ["gold", "crypto", "bonds", "energy", "metals", "power", "quantum"];
    const run = v.value(startResearchRun, { scope: { held: false, segments: keys } }).run;
    keys.forEach((segment, k) => {
      segmentNoted(v, k + 1, segment, {}, run);
    });
    const segments = viewValue(v, new market.InMemoryPriceCache());
    const block = researchDigest(i.read, {
      now: nowOf(v),
      since: nowOf(v) - 7n * research.MICROS_PER_DAY,
      segments: research.digestSegments(segments),
    });
    expect("themes_changed" in block).toBe(false);
    expect(block.segments).toHaveLength(6); // top rows only
    expect((block.segments as research.SegmentRow[]).slice(0, 2).map((r) => r.segment)).toEqual([
      "bonds",
      "gold",
    ]); // catalog order
    const market_ = block.market as Record<string, unknown>;
    expect(market_.window).toBe("1w");
    expect("segments" in market_).toBe(false);
    for (const k of ["portfolio_return", "explained", "residual", "currency", "unassigned"]) {
      expect(k in market_).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ attribution

const START = addDays(TODAY, -7);
const d = (days: number) => addDays(TODAY, -days);

let seq = 0;
function txn(v: Vault, account: string, instrument: string | null, data: Record<string, unknown>) {
  const dedupHash = (++seq).toString(16).padStart(64, "f");
  return {
    type: "invTxn.imported",
    gid: v.det("inv_transactions", [account, dedupHash]),
    data: {
      account,
      batch: null,
      type: "buy",
      tradeDate: d(20),
      settleDate: null,
      instrument,
      quantity: null,
      price: null,
      currency: "PLN",
      grossAmount: "0",
      fee: "0",
      tax: "0",
      cashAmount: "0",
      cashCurrency: "PLN",
      fxRate: null,
      splitRatio: null,
      note: null,
      source: "import",
      externalRef: null,
      dedupHash,
      createdAt: `${d(20)}T10:00:00.000001Z`,
      ...data,
    },
  };
}

/**
 * Python `_moving_portfolio`: a PLN deposit, ABC (PLN) +10 % and WRLD (EUR) -10 % within the window
 * with EUR +10 %, a cost-valued treasury bond, cash, and XMPL (USD, flat) bought mid-window.
 * `eurFrom`: EUR rates only from that day on; `eurGap`: no EUR rate in the days up to the start.
 */
function movingPortfolio(o: { eurFrom?: string; eurGap?: number } = {}) {
  const v = vault();
  const account = brokerageOf(v);
  const abc = stock(v, "ABC", "PLABC0000016", { aliases: [yahoo("ABC.WA")] });
  const wrld = stock(v, "WRLD", "IE00BEXAMPL1", {
    currency: "EUR",
    assetClass: "etf",
    mic: "XETR",
    aliases: [yahoo("WRLD.DE")],
  });
  const edox = stock(v, "EDOX", "PL0000000002", { assetClass: "treasury_bond" });
  const xmpl = stock(v, "XMPL", "US0000000001", {
    currency: "USD",
    mic: "XNAS",
    aliases: [yahoo("XMPL")],
  });
  applyRawEvents(v, [
    txn(v, account, null, { type: "deposit", tradeDate: d(30), cashAmount: "20000.00" }),
    txn(v, account, abc, {
      quantity: "100",
      price: "50.00",
      grossAmount: "5000.00",
      cashAmount: "-5000.00",
    }),
    txn(v, account, wrld, {
      quantity: "10",
      price: "100.00",
      currency: "EUR",
      grossAmount: "1000.00",
      cashAmount: "-4000.00",
      fxRate: "4.0",
    }),
    txn(v, account, edox, {
      quantity: "10",
      price: "100.00",
      grossAmount: "1000.00",
      cashAmount: "-1000.00",
    }),
    txn(v, account, xmpl, {
      tradeDate: d(3),
      quantity: "10",
      price: "100.00",
      currency: "USD",
      grossAmount: "1000.00",
      cashAmount: "-4000.00",
      fxRate: "4.0",
      createdAt: `${d(3)}T10:00:00.000001Z`,
    }),
  ]);
  v.value(setInstrumentSegment, { instrument: abc, segment: "equity_pl", by: "owner" });
  v.value(setInstrumentSegment, { instrument: wrld, segment: "equity_global", by: "owner" });
  const cache = new market.InMemoryPriceCache();
  putBars(cache, "ABC.WA", TODAY, 40, (day) => (day <= START ? "50" : "55"), "PLN");
  putBars(cache, "WRLD.DE", TODAY, 40, (day) => (day <= START ? "100" : "90"), "EUR");
  putBars(cache, "XMPL", TODAY, 40, () => "100", "USD");
  const days = Array.from({ length: 41 }, (_, k) => addDays(TODAY, k - 40));
  const gap = o.eurGap ?? 0;
  putRates(
    cache,
    "EUR",
    days.filter(
      (day) =>
        (o.eurFrom === undefined || day >= o.eurFrom) &&
        !(addDays(START, -gap) < day && day <= START),
    ),
    (day) => (day <= START ? "4.0" : "4.4"),
  );
  putRates(cache, "USD", days, () => "4.0");
  return { v, cache, abc, wrld, edox, xmpl };
}

describe("attribution through the service", () => {
  it("test_attribution_with_moving_prices_fx_cost_holding_cash_and_a_mid_window_buy", () => {
    const { v, cache } = movingPortfolio();
    const out = viewValue(v, cache);
    const rows = new Map(out.segments.map((r) => [r.segment, r]));
    expect(out.segments.map((r) => r.segment)).toEqual(["equity_pl", "equity_global", "bonds"]);
    const pl = rows.get("equity_pl");
    const world = rows.get("equity_global");
    const bonds = rows.get("bonds");
    // T0 = 10000 cash + 5000 ABC + 4000 WRLD (10 x 100 EUR x 4.0) + 1000 bond at cost
    expect([pl?.weight, pl?.contribution, pl?.return]).toEqual([0.25, 0.025, 0.1]);
    expect([world?.weight, world?.contribution, world?.return]).toEqual([0.2, -0.02, -0.1]);
    expect([bonds?.weight, bonds?.contribution, bonds?.return]).toEqual([0.05, 0.0, null]);
    expect(bonds?.instruments[0]?.label).toBe("EDOX");
    expect(out.unassigned).toBeNull();
    expect(out.new_positions).toBe(1); // XMPL
    expect(out.currency.currencies).toHaveLength(1);
    const [eur] = out.currency.currencies;
    expect([eur?.currency, eur?.weight, eur?.return]).toEqual(["EUR", 0.2, 0.1]);
    expect(eur?.contribution).toBe(0.018);
    expect(out.currency.contribution).toBe(0.018);
    expect(out.explained).toBe(0.023);
    expect(out.portfolio_return).toBe(0.023);
    expect(out.residual).toBe(0.0);
    expect(out.stale).toEqual([]);
  });

  it("test_a_start_rate_too_old_still_values_the_holding_and_flags_it", () => {
    const { v, cache, wrld } = movingPortfolio({ eurGap: 15 }); // the newest EUR rate is 16 days old
    const out = viewValue(v, cache);
    const rows = new Map(out.segments.map((r) => [r.segment, r]));
    expect(rows.get("equity_global")?.weight).toBe(0.2);
    expect(rows.get("equity_global")?.contribution).toBe(-0.02);
    expect(rows.get("equity_pl")?.weight).toBe(0.25); // T0 still has WRLD
    expect(out.new_positions).toBe(1); // WRLD was held: only XMPL is new
    expect(out.stale).toContain(wrld);
  });

  it("test_a_holding_without_any_start_rate_is_left_out_and_flagged", () => {
    const { v, cache, wrld } = movingPortfolio({ eurFrom: addDays(START, 1) });
    const out = viewValue(v, cache);
    const rows = new Map(out.segments.map((r) => [r.segment, r]));
    const world = rows.get("equity_global"); // still held: a topic row without exposure (P7)
    expect([world?.weight, world?.contribution, world?.return]).toEqual([0.0, 0.0, null]);
    expect([world?.trend_1w, world?.members]).toEqual([-0.1, 1]);
    expect(out.segments.at(-1)?.segment).toBe("equity_global"); // after the rows with exposure
    expect(rows.get("equity_pl")?.weight).toBe(research.roundShare(5000 / 16000));
    expect(out.new_positions).toBe(1);
    expect(out.stale).toContain(wrld);
  });

  it("test_rounding_never_gives_negative_zero", () => {
    expect(Object.is(research.roundShare(-1e-9), 0)).toBe(true);
    expect(research.roundShare(null)).toBeNull();
    expect(research.roundShare(-0.0123456789)).toBe(-0.012346);
  });
});
