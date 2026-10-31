/**
 * Test-for-test translation of `tests/investments/performance/test_perf_attribution.py`: P/L
 * attribution by instrument and bucket, account-level items and profit concentration,
 * hand-computed (through the daily series, so the end values are the series' own). Synthetic data
 * only. Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { D, type Decimal, floatRepr } from "../../decimal.js";
import { allocationPlan, bucketDef, bucketMatch } from "../domain/buckets.js";
import { AssetClass } from "../domain/enums.js";
import { type Instrument, instrumentRename } from "../domain/instrument.js";
import type { PriceBar } from "../domain/marketData.js";
import type { Transaction } from "../domain/transaction.js";
import { asInstrumentId, type CalendarDate, type InstrumentId } from "../domain/values.js";
import { InMemoryFxLookup } from "../portfolio/index.js";
import {
  accountLevelTotal,
  attribute,
  bucketOf,
  concentration,
  groupByBucket,
  type InstrumentPnl,
  instrumentsPnl,
  pnlOf,
} from "./attribution.js";
import { Renames } from "./renames.js";
import { computeRange, rangeBase } from "./report.js";
import { buildSeries, combineSeries, type HoldingValues } from "./series.js";
import { bars, day, days, EUR, instrument, PLN, rates, txn } from "./testing/support.js";

/** `pytest.approx` with its defaults (rel 1e-6, abs 1e-12). */
function expectApprox(actual: number | null | undefined, expected: number): void {
  expect(actual).not.toBeNull();
  expect(actual).not.toBeUndefined();
  const tolerance = Math.max(1e-6 * Math.abs(expected), 1e-12);
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
}

const iid = (text: string): InstrumentId => asInstrumentId(text);

const END = day("2025-01-31");
const FX = rates(EUR, Object.fromEntries(days("2024-12-28", "2025-01-31").map((d) => [d, "4.0"])));

function history(): [Transaction[], Map<InstrumentId, Instrument>, Map<InstrumentId, PriceBar[]>] {
  // A (PLN equity): bought 10 @ 100 + 5 fee, sold 10 @ 120 - 5 fee        -> P/L 1195 - 1005 = 190
  // B (EUR ETF): bought 10 @ 50 EUR for 2000 PLN, dividend 80 PLN, worth 10 * 55 * 4.0 at the end
  //                                                                        -> 2200 - 2000 + 80 = 280
  // account: fee 10, interest 3                                            -> -7
  // portfolio: cash 10000 - 1005 - 2000 + 80 + 1195 - 10 + 3 = 8263, + 2200 = 10463 -> P/L 463
  const txns = [
    txn("deposit", "2025-01-02", "10000"),
    txn("buy", "2025-01-02", "-1005", { instrument: "A", quantity: "10", price: "100", fee: "5" }),
    txn("buy", "2025-01-02", "-2000", {
      instrument: "B",
      quantity: "10",
      price: "50",
      currency: EUR,
      cashCurrency: PLN,
    }),
    txn("dividend", "2025-01-10", "80", { instrument: "B" }),
    txn("sell", "2025-01-15", "1195", { instrument: "A", quantity: "10", price: "120", fee: "5" }),
    txn("fee", "2025-01-20", "-10"),
    txn("interest", "2025-01-20", "3"),
  ];
  const insts = new Map<InstrumentId, Instrument>([
    [iid("A"), instrument("A", PLN, AssetClass.EQUITY)],
    [iid("B"), instrument("B", EUR, AssetClass.ETF)],
  ]);
  const month = days("2025-01-01", "2025-01-31");
  const a = Object.fromEntries(month.map((d, i) => [d, 100 + i]));
  const b = Object.fromEntries(month.map((d) => [d, 55]));
  return [
    txns,
    insts,
    new Map([
      [iid("A"), bars("A", a)],
      [iid("B"), bars("B", b)],
    ]),
  ];
}

function run(startKey: "max" = "max", start: CalendarDate | null = null) {
  const [txns, insts, barMap] = history();
  const fx = new InMemoryFxLookup(FX);
  const captures = new Set<CalendarDate>([END, ...(start ? [start] : [])]);
  const s = buildSeries(txns, {
    instruments: insts,
    bars: barMap,
    fx,
    base: PLN,
    end: END,
    captureDates: captures,
  });
  const base = start ?? rangeBase(startKey, END, s.dates[0] as CalendarDate);
  const result = attribute(txns, {
    start: base,
    end: END,
    startValues: s.captures.get(base) ?? (new Map() as HoldingValues),
    endValues: s.captures.get(END) as HoldingValues,
    txnValues: s.txnValues,
    fx,
    base: PLN,
    renames: new Renames([]),
  });
  return { s, result, insts };
}

function byId(rows: readonly InstrumentPnl[]): Map<InstrumentId, InstrumentPnl> {
  return new Map(rows.map((r) => [r.instrumentId, r]));
}

function get(rows: Map<InstrumentId, InstrumentPnl>, id: string): InstrumentPnl {
  const r = rows.get(iid(id));
  expect(r).toBeDefined();
  return r as InstrumentPnl;
}

const eq = (value: Decimal, expected: string | number): boolean => value.eq(D(String(expected)));

describe("performance attribution", () => {
  // test_instrument_pnl_account_level_and_the_rest
  it("instrument P/L, account level and the rest", () => {
    const { s, result } = run();
    const rows = byId(result.instruments);
    expect(result.instruments.map((r) => r.instrumentId)).toEqual(["B", "A"]); // largest P/L first
    const a = get(rows, "A");
    const b = get(rows, "B");
    expect(eq(pnlOf(a), 190) && !a.held).toBe(true);
    expect([eq(a.invested, 1005), eq(a.returned, 1195)]).toEqual([true, true]);
    expect(eq(pnlOf(b), 280) && b.held).toBe(true);
    expect([eq(b.endValue, 2200), eq(b.income, 80)]).toEqual([true, true]);
    const level = result.accountLevel;
    expect([eq(level.fees, 10), eq(level.interest, 3), eq(accountLevelTotal(level), -7)]).toEqual([
      true,
      true,
      true,
    ]);
    const metrics = computeRange("max", s.dates, combineSeries(s), null);
    expectApprox(metrics.summary.pnl, 463);
    const other = D(floatRepr(metrics.summary.pnl))
      .sub(instrumentsPnl(result))
      .sub(accountLevelTotal(level));
    expect(other.isZero()).toBe(true);
  });

  // test_range_starting_mid_history_uses_the_value_at_the_base_day
  it("range starting mid history uses the value at the base day", () => {
    // On 01-12 A is still held: 10 units at the 01-12 close (111) = 1110 -> P/L in range 1195 - 1110
    const { result } = run("max", day("2025-01-12"));
    const rows = byId(result.instruments);
    expect(eq(get(rows, "A").startValue, 1110)).toBe(true);
    expect(eq(pnlOf(get(rows, "A")), 85)).toBe(true);
    expect(eq(pnlOf(get(rows, "B")), 0)).toBe(true); // flat price, the dividend was before the range
  });

  // test_concentration_and_buckets
  it("concentration and buckets", () => {
    const { result, insts } = run();
    const conc = concentration(result.instruments.map((r) => [r.instrumentId, pnlOf(r)] as const));
    expect(eq(conc.total, 470)).toBe(true);
    const shares = new Map(conc.topShares);
    expectApprox(shares.get(1), 280 / 470);
    expectApprox(shares.get(2), 1.0);
    expect(conc.top2).toEqual(["B", "A"]);
    expect(conc.pnlWithoutTop2.isZero()).toBe(true);
    const plan = allocationPlan({
      buckets: [
        bucketDef({ id: "stocks", match: bucketMatch({ assetClasses: [AssetClass.EQUITY] }) }),
        bucketDef({ id: "funds", match: bucketMatch({ assetClasses: [AssetClass.ETF] }) }),
      ],
      targets: { stocks: 0.5, funds: 0.5 },
    });
    const grouped = groupByBucket(result.instruments, (i) =>
      bucketOf(insts.get(i) as Instrument, plan),
    );
    expect(grouped).toHaveLength(2);
    expect(grouped.map(([k, , n]) => [k, n])).toEqual([
      ["funds", 1],
      ["stocks", 1],
    ]);
    expect(eq((grouped[0] as [string, Decimal, number])[1], 280)).toBe(true);
    expect(eq((grouped[1] as [string, Decimal, number])[1], 190)).toBe(true);
    expect(bucketOf(insts.get(iid("A")) as Instrument, null)).toBe("equity"); // no buckets: the asset class
    expect(bucketOf(null, plan)).toBe("unclassified");
  });

  // test_concentration_when_others_lose
  it("concentration when others lose", () => {
    const conc = concentration([
      [iid("X"), D("300")],
      [iid("Y"), D("100")],
      [iid("Z"), D("-200")],
      [iid("W"), D("-100")],
    ]);
    const shares = new Map(conc.topShares);
    expect(eq(conc.total, 100)).toBe(true);
    expectApprox(shares.get(1), 3.0); // one winner made three times the total
    expect(eq(conc.pnlWithoutTop2, -300)).toBe(true);
    expect([conc.positive, conc.negative]).toEqual([2, 2]);
    expect(new Map(concentration([[iid("X"), D("-5")]]).topShares).get(1)).toBeNull();
  });

  // test_renamed_instrument_is_one_line
  it("renamed instrument is one line", () => {
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "OLD", quantity: "10", price: "100" }),
      txn("sell", "2025-01-20", "1300", { instrument: "OLD", quantity: "10", price: "130" }),
    ];
    const renames = [
      instrumentRename({
        date: day("2025-01-10"),
        oldInstrumentId: iid("OLD"),
        newInstrumentId: iid("NEW"),
      }),
    ];
    const result = attribute(txns, {
      start: day("2025-01-01"),
      end: END,
      startValues: new Map(),
      endValues: new Map(),
      txnValues: new Map(),
      fx: new InMemoryFxLookup([]),
      base: PLN,
      renames: new Renames(renames),
    });
    expect(result.instruments).toHaveLength(1);
    const only = result.instruments[0] as InstrumentPnl;
    expect(only.instrumentId).toBe("NEW");
    expect(eq(pnlOf(only), 300)).toBe(true);
  });
});
