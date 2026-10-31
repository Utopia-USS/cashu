/**
 * Test-for-test translation of `tests/investments/performance/test_p5_segment_attribution.py`:
 * segment attribution (P5), pure and hand-computed. A PLN stock, a USD ETF and a USD crypto holding
 * with an FX move, a holding without a segment (with a stale close), a cost-valued holding and cash
 * in T0, a position opened within the window; contributions add up to `explained`; T0 = 0 is empty.
 * Synthetic data only. Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { D, floatRepr } from "../../decimal.js";
import type { PriceBar } from "../domain/marketData.js";
import { asInstrumentId, type InstrumentId } from "../domain/values.js";
import { InMemoryFxLookup } from "../portfolio/index.js";
import {
  attributeSegments,
  closeOnOrBefore,
  isEmptyAttribution,
  type SegmentAttribution,
  type SegmentMove,
  type StartPortfolio,
  startHolding,
  startPortfolio,
} from "./segmentAttribution.js";
import { bars, day, PLN, rates, USD } from "./testing/support.js";

/** `pytest.approx` with its defaults (rel 1e-6, abs 1e-12). */
function expectApprox(actual: number | null | undefined, expected: number): void {
  expect(actual).not.toBeNull();
  expect(actual).not.toBeUndefined();
  const tolerance = Math.max(1e-6 * Math.abs(expected), 1e-12);
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
}

const iid = (text: string): InstrumentId => asInstrumentId(text);

const START = day("2026-10-01");
const END = day("2026-10-08");
const SEGMENTS: Readonly<Record<string, string>> = {
  A: "equity_pl",
  B: "gold",
  C: "crypto",
  E: "bonds",
};
const segmentsGet = (i: InstrumentId): string | null => SEGMENTS[i] ?? null;
const FX = new InMemoryFxLookup(rates(USD, { "2026-10-01": "4.0", "2026-10-08": "4.2" }));

function portfolio(): StartPortfolio {
  // T0 = 4000 (A) + 2000 (B: 10 x 50 USD x 4.0) + 1000 (C: 0.01 x 25000 USD x 4.0) + 500 (D)
  //      + 1500 (E, valued at cost) + 1000 cash = 10000
  return startPortfolio({
    totalBase: D("10000"),
    holdings: [
      startHolding({ instrumentId: iid("A"), currency: PLN, valueBase: D("3000") }),
      startHolding({ instrumentId: iid("A"), currency: PLN, valueBase: D("1000") }), // a second account: summed
      startHolding({ instrumentId: iid("B"), currency: USD, valueBase: D("2000") }),
      startHolding({ instrumentId: iid("C"), currency: USD, valueBase: D("1000") }),
      startHolding({ instrumentId: iid("D"), currency: PLN, valueBase: D("500") }),
      startHolding({ instrumentId: iid("E"), currency: PLN, valueBase: D("1500"), market: false }),
    ],
  });
}

const PRICES = new Map<InstrumentId, PriceBar[]>([
  [iid("A"), bars("A", { "2026-09-30": 100, "2026-10-08": 110 })], // +10 %
  [iid("B"), bars("B", { "2026-10-01": 50, "2026-10-07": 45 })], // -10 % in USD
  [iid("C"), bars("C", { "2026-10-01": 25000, "2026-10-08": 30000 })], // +20 % in USD
  [iid("D"), bars("D", { "2026-10-01": 10, "2026-10-02": 9 })], // -10 %, last close 6 days old: stale
  [iid("E"), bars("E", { "2026-10-01": 100, "2026-10-08": 200 })], // cost-valued: never attributed
]);

function run(total: number | null = null): SegmentAttribution {
  const start =
    total === null
      ? portfolio()
      : startPortfolio({ totalBase: D(String(total)), holdings: portfolio().holdings });
  return attributeSegments(start, PRICES, FX, PLN, START, END, segmentsGet, {
    heldAtEnd: [iid("A"), iid("B"), iid("F")],
  });
}

function bySegment(result: SegmentAttribution): Map<string | null, SegmentMove> {
  return new Map(result.segments.map((m) => [m.segment, m]));
}

function get(rows: Map<string | null, SegmentMove>, key: string): SegmentMove {
  const row = rows.get(key);
  expect(row).toBeDefined();
  return row as SegmentMove;
}

describe("segment attribution (P5)", () => {
  // test_hand_computed_example
  it("hand computed example", () => {
    const result = run();
    const rows = bySegment(result);
    expect(result.segments.map((m) => m.segment)).toEqual(["equity_pl", "crypto", "gold", "bonds"]);
    expectApprox(get(rows, "equity_pl").contribution, (4000 * 0.1) / 10000);
    expectApprox(get(rows, "equity_pl").weight, 0.4);
    expectApprox(get(rows, "equity_pl").ret, 0.1);
    expectApprox(get(rows, "gold").contribution, (2000 * -0.1) / 10000);
    expectApprox(get(rows, "gold").weight, 0.2);
    expectApprox(get(rows, "gold").ret, -0.1);
    expectApprox(get(rows, "crypto").contribution, (1000 * 0.2) / 10000);
    const goldInstruments = get(rows, "gold").instruments;
    expect(goldInstruments).toHaveLength(1);
    const b = goldInstruments[0];
    expect(b?.instrumentId).toBe("B");
    expectApprox(b?.contribution, -0.02);
    expect(b?.ret).toBe(-0.1);
    // E is valued at cost: its weight shows, it contributes 0 and has no market return
    const bonds = get(rows, "bonds");
    expectApprox(bonds.weight, 0.15);
    expect(bonds.contribution).toBe(0.0);
    expect(bonds.ret).toBeNull();
    expect(bonds.instruments).toHaveLength(1);
    const e = bonds.instruments[0];
    expect([e?.instrumentId, e?.contribution, e?.ret]).toEqual(["E", 0.0, null]);
    expect(result.unassigned).not.toBeNull();
    const unassigned = result.unassigned as SegmentMove;
    expect(unassigned.segment).toBeNull();
    expectApprox(unassigned.contribution, (500 * -0.1) / 10000);
    expectApprox(unassigned.weight, 0.05);
    // currency: B 2000 x (0.9 x 1.05 - 1 - (-0.1)) + C 1000 x (1.2 x 1.05 - 1 - 0.2)
    expectApprox(result.currencyContribution, (2000 * 0.045 + 1000 * 0.06) / 10000);
    expect(result.currencies).toHaveLength(1);
    const usd = result.currencies[0];
    expect(usd?.currency).toBe("USD");
    expectApprox(usd?.weight, 0.3);
    expectApprox(usd?.ret, 0.05);
    expectApprox(usd?.contribution, 0.015);
    // Python `sum(...)` starts at int 0 and adds left to right
    const parts =
      result.segments.reduce((acc, m) => acc + m.contribution, 0) + unassigned.contribution;
    expectApprox(result.explained, parts + result.currencyContribution);
    expectApprox(result.explained, 0.05);
    expect(result.newPositions).toBe(1); // F opened within the window
    expect(result.stale).toEqual(["D"]);
  });

  // test_instruments_sorted_by_absolute_contribution
  it("instruments sorted by absolute contribution", () => {
    const segments: Readonly<Record<string, string>> = {
      A: "equity_pl",
      B: "equity_pl",
      C: "equity_pl",
      D: "equity_pl",
    };
    const result = attributeSegments(
      portfolio(),
      PRICES,
      FX,
      PLN,
      START,
      END,
      (i) => segments[i] ?? null,
    );
    expect(result.segments).toHaveLength(1);
    const row = result.segments[0] as SegmentMove;
    expect(row.instruments.map((m) => m.instrumentId)).toEqual(["A", "B", "C", "D"]); // ties by id
    expectApprox(row.ret, (400 - 200 + 200 - 50) / 7500);
    expectApprox(row.weight, 0.75);
    // without a segment the cost-valued holding is unassigned weight
    const unassigned = result.unassigned as SegmentMove;
    expectApprox(unassigned.weight, 0.15);
    expect(unassigned.contribution).toBe(0.0);
    expect(unassigned.ret).toBeNull();
  });

  // test_zero_or_negative_total_is_empty
  it("zero or negative total is empty", () => {
    for (const total of [0, -5]) {
      const result = run(total);
      expect(isEmptyAttribution(result)).toBe(true);
      expect(result.explained).toBe(0);
      expect(result.currencyContribution).toBe(0);
      expect(result.newPositions).toBe(1);
    }
  });

  // test_missing_closes_count_as_no_move_and_are_flagged
  it("missing closes count as no move and are flagged", () => {
    const prices = new Map(PRICES);
    prices.set(iid("A"), bars("A", { "2026-10-05": 100 }));
    const result = attributeSegments(portfolio(), prices, FX, PLN, START, END, segmentsGet, {
      maxPriceAgeDays: 5,
    });
    const rows = bySegment(result);
    expect(get(rows, "equity_pl").contribution).toBe(0);
    expect(result.stale).toContain("A");
    const missingFx = attributeSegments(
      portfolio(),
      PRICES,
      new InMemoryFxLookup([]),
      PLN,
      START,
      END,
      segmentsGet,
    );
    expect(missingFx.currencyContribution).toBe(0);
  });

  // test_close_on_or_before
  it("close on or before", () => {
    const series = bars("X", { "2026-10-01": 1, "2026-10-03": 2 });
    expect(closeOnOrBefore(series, day("2026-09-30"))).toBeNull();
    expect(closeOnOrBefore(series, day("2026-10-02"))?.close.eq(D("1"))).toBe(true);
    // Python passes `dt.date(2026, 10, 9)`: the same ISO date here
    expect(closeOnOrBefore(series, "2026-10-09")?.close.eq(D("2"))).toBe(true);
  });

  // test_held_at_start_is_never_new_and_unvalued_or_stale_holdings_are_flagged
  it("held at start is never new and unvalued or stale holdings are flagged", () => {
    const base = portfolio();
    const start = startPortfolio({
      totalBase: base.totalBase,
      holdings: [
        ...base.holdings.slice(0, 4),
        startHolding({ instrumentId: iid("D"), currency: PLN, valueBase: D("500"), stale: true }),
      ],
      unvalued: [iid("G")],
      held: ["A", "B", "C", "D", "E", "G", "H"].map(iid),
    });
    const result = attributeSegments(start, PRICES, FX, PLN, START, END, segmentsGet, {
      heldAtEnd: [iid("G"), iid("H"), iid("F")],
    });
    expect(result.newPositions).toBe(1); // only F; G (unvalued) and H (cash-like) were held
    expect(new Set(result.stale)).toEqual(new Set(["D", "G"]));
    const listed = new Set(
      result.segments.flatMap((row) => row.instruments.map((m) => m.instrumentId)),
    );
    expect(listed.has(iid("G"))).toBe(false);
  });

  // test_no_negative_zero
  it("no negative zero", () => {
    const flat = new Map(
      [..."ABCDE"].map((k) => [iid(k), bars(k, { "2026-10-01": 1, "2026-10-08": 1 })] as const),
    );
    const result = attributeSegments(
      portfolio(),
      flat,
      new InMemoryFxLookup([]),
      PLN,
      START,
      END,
      () => "gold",
    );
    expect(result.segments).toHaveLength(1);
    const row = result.segments[0] as SegmentMove;
    expect(floatRepr(row.contribution)).toBe("0.0");
    expect(floatRepr(result.explained)).toBe("0.0");
  });
});
