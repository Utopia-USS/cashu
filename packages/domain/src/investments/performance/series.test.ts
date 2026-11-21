/**
 * Daily value / flow series, hand-computed (deposits and FX, splits, a sale, an unbooked split, units
 * moved in and out, implied funding, incomplete days), and the incremental snapshots against
 * `buildSnapshot` / `valuePortfolio`.
 */
import { describe, expect, it } from "vitest";
import { D, type Decimal, decimalKey, floatRepr, ZERO } from "../../decimal.js";
import { AssetClass, ValuationMode } from "../domain/enums.js";
import { type Instrument, instrumentRename } from "../domain/instrument.js";
import type { FxRate, PriceBar } from "../domain/marketData.js";
import { countedBase, marketView } from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import {
  type AccountId,
  asAccountId,
  asInstrumentId,
  asProfileId,
  type CalendarDate,
  type InstrumentId,
} from "../domain/values.js";
import { buildSnapshot, Fraction, InMemoryFxLookup, valuePortfolio } from "../portfolio/index.js";
import {
  buildSeries,
  combineSeries,
  computeRange,
  holdingKey,
  type PortfolioSeries,
  periodReturn,
  SnapshotStream,
  seriesIndexOf,
  twrIndex,
  type ValuationPolicy,
} from "./index.js";
import {
  approxEq,
  bars,
  day,
  days,
  EUR,
  expectApprox,
  expectApproxList,
  instrument,
  PLN,
  rates,
  txn,
  USD,
} from "./testing/support.js";

const instrumentMap = (insts: readonly Instrument[]): Map<InstrumentId, Instrument> =>
  new Map(insts.map((i) => [i.id, i]));

const barMapOf = (m: Readonly<Record<string, PriceBar[]>>): Map<InstrumentId, PriceBar[]> =>
  new Map(Object.entries(m).map(([k, v]) => [asInstrumentId(k), v]));

function seriesOf(
  txns: readonly Transaction[],
  insts: readonly Instrument[],
  barMap: Readonly<Record<string, PriceBar[]>>,
  fx: readonly FxRate[] = [],
  end = "2025-01-05",
  kw: { readonly policy?: ValuationPolicy } = {},
): PortfolioSeries {
  return buildSeries(txns, {
    instruments: instrumentMap(insts),
    bars: barMapOf(barMap),
    fx: new InMemoryFxLookup([...fx]),
    base: PLN,
    end: day(end),
    ...kw,
  });
}

function values(series: PortfolioSeries, accountIds: ReadonlySet<AccountId> | null = null) {
  return combineSeries(series, accountIds).values;
}

function twr(series: PortfolioSeries): number | null {
  const c = combineSeries(series);
  return periodReturn(twrIndex(c.values, c.flows, c.complete));
}

/** Decimal-valued map compared by value (Python dict `==`). */
const decimalMap = (m: ReadonlyMap<string, Decimal>): Record<string, string> =>
  Object.fromEntries([...m].map(([k, v]) => [k, decimalKey(v)]));

describe("daily series", () => {
  it("deposit and a USD holding valued at daily FX", () => {
    // 10 000 PLN in; 10 X bought at 100 USD for 4 000 PLN (rate 4.0). Next day X = 110 USD at 4.2:
    // 6 000 cash + 10 * 110 * 4.2 = 10 620.
    const txns = [
      txn("deposit", "2025-01-02", "10000"),
      txn("buy", "2025-01-02", "-4000", {
        instrument: "X",
        quantity: "10",
        price: "100",
        currency: USD,
        cashCurrency: PLN,
      }),
    ];
    const s = seriesOf(
      txns,
      [instrument("X", USD)],
      { X: bars("X", { "2025-01-02": "100", "2025-01-03": "110" }) },
      rates(USD, { "2025-01-02": "4.0", "2025-01-03": "4.2" }),
      "2025-01-03",
    );
    expect(s.dates).toEqual(days("2025-01-01", "2025-01-03"));
    expectApproxList(values(s), [0, 10000, 10620]);
    expectApproxList(combineSeries(s).flows, [0, 10000, 0]);
    expectApprox(twr(s), 0.062);
  });

  it("split keeps the series continuous", () => {
    // The source serves split-adjusted closes (a 4:1 split on 01-04: 100 before = 25 adjusted).
    // 10 units before the split are valued at 25 * 4; 40 after it at the plain close.
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "S", quantity: "10", price: "100" }),
      txn("split", "2025-01-04", "0", { instrument: "S", ratio: "4" }),
    ];
    const adjusted = {
      "2025-01-02": "25",
      "2025-01-03": 27.5,
      "2025-01-04": 27.5,
      "2025-01-05": "30",
    };
    const s = seriesOf(txns, [instrument("S")], { S: bars("S", adjusted) });
    expectApproxList(values(s), [0, 1000, 1100, 1100, 1200]);
    expectApprox(twr(s), 0.2);
    expect(s.priceScales).toEqual([]); // the trade price matched the split-adjusted close x 4
  });

  it("sale and cash afterwards", () => {
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "A", quantity: "10", price: "100" }),
      txn("sell", "2025-01-04", "1200", { instrument: "A", quantity: "10", price: "120" }),
    ];
    const closes = {
      "2025-01-02": "100",
      "2025-01-03": "105",
      "2025-01-04": "120",
      "2025-01-05": "130",
    };
    const s = seriesOf(txns, [instrument("A")], { A: bars("A", closes) });
    expectApproxList(values(s), [0, 1000, 1050, 1200, 1200]);
    expectApprox(twr(s), 0.2);
    const metrics = computeRange("max", s.dates, combineSeries(s), null);
    expectApprox(metrics.summary.pnl, 200);
    expectApprox(metrics.summary.netContributions, 1000);
  });

  it("split the history never booked is inferred from trades", () => {
    // Held 01-02..01-03, sold; a 2:1 split later (not in the history) halved every stored close.
    // Trade prices are exactly twice the closes: the closes up to the sale are scaled by 2.
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "B", quantity: "10", price: "100" }),
      txn("sell", "2025-01-03", "1100", { instrument: "B", quantity: "10", price: "110" }),
    ];
    const adjusted = { "2025-01-02": "50", "2025-01-03": "55", "2025-01-10": "60" };
    const s = seriesOf(txns, [instrument("B")], { B: bars("B", adjusted) }, [], "2025-01-04");
    expectApproxList(values(s), [0, 1000, 1100, 1100]);
    expectApprox(twr(s), 0.1);
    // Python compares the Fraction factor with the int 2
    expect(s.priceScales.map((p) => [p.until, p.factor.eq(Fraction.of(2))])).toEqual([
      [day("2025-01-02"), true],
      [day("2025-01-03"), true],
    ]);
  });

  it("off-scale trade without a clean multiple is reported", () => {
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "C", quantity: "10", price: "100" }),
    ];
    const s = seriesOf(
      txns,
      [instrument("C")],
      { C: bars("C", { "2025-01-02": "62" }) },
      [],
      "2025-01-02",
    );
    expect(s.priceScales).toEqual([]);
    expect(s.priceMismatches.length === 1 && s.priceMismatches[0]?.instrumentId === "C").toBe(true);
  });

  it("units moved in and out are flows at that day's value", () => {
    // Flows come at the end of their day: units in at that day's close (100, they earn nothing that
    // day), units out at that day's close (120, the day's move from 110 is still ours).
    const txns = [
      txn("transfer_in", "2025-01-02", "0", { instrument: "T", quantity: "10", tid: "in" }),
      txn("transfer_out", "2025-01-04", "0", { instrument: "T", quantity: "10", tid: "out" }),
    ];
    const closes = {
      "2025-01-01": "99",
      "2025-01-02": "100",
      "2025-01-03": "110",
      "2025-01-04": "120",
    };
    const s = seriesOf(txns, [instrument("T")], { T: bars("T", closes) });
    const c = combineSeries(s);
    expectApproxList(c.values, [0, 1000, 1100, 0, 0]);
    expectApproxList(c.flows, [0, 1000, 0, -1200, 0]);
    expectApprox(twr(s), 0.2);
    expect(decimalMap(s.txnValues)).toEqual({ in: "1000", out: "1200" });
  });

  it("adjustment adds units at the day's value", () => {
    const txns = [
      txn("adjustment", "2025-01-02", "0", {
        instrument: "T",
        quantity: "10",
        price: "1",
        tid: "adj",
      }),
    ];
    const s = seriesOf(
      txns,
      [instrument("T")],
      { T: bars("T", { "2025-01-02": "100" }) },
      [],
      "2025-01-02",
    );
    expectApproxList(combineSeries(s).flows, [0, 1000]);
    expect(decimalMap(s.txnValues)).toEqual({ adj: "1000" });
  });

  it("buy without its deposit is implied funding", () => {
    // Cash goes to -1000 (counted as 0): the bought units are money from outside the history. The
    // deposit that later fills the hole is not new money (implied -1000, deposit +1000).
    const txns = [
      txn("buy", "2025-01-02", "-1000", { instrument: "A", quantity: "10", price: "100" }),
      txn("deposit", "2025-01-03", "1000"),
    ];
    const s = seriesOf(
      txns,
      [instrument("A")],
      { A: bars("A", { "2025-01-02": "100", "2025-01-03": "110" }) },
      [],
      "2025-01-03",
    );
    const c = combineSeries(s);
    expectApproxList(c.values, [0, 1000, 1100]);
    expectApproxList(c.flows, [0, 1000, 0]);
    expectApproxList(c.implied, [0, 1000, -1000]);
    expectApprox(twr(s), 0.1);
  });

  it("negative cash then deposit covering it", () => {
    const txns = [
      txn("buy", "2025-01-02", "-1000", { instrument: "A", quantity: "10", price: "100" }),
      txn("deposit", "2025-01-04", "1500"),
    ];
    const s = seriesOf(
      txns,
      [instrument("A")],
      { A: bars("A", { "2025-01-02": "100", "2025-01-03": "110", "2025-01-04": "110" }) },
      [],
      "2025-01-04",
    );
    const c = combineSeries(s);
    // after the deposit cash is +500: value 1100 + 500; flows: deposit 1500, implied -1000
    expectApproxList(c.values, [0, 1000, 1100, 1600]);
    expectApproxList(c.flows, [0, 1000, 0, 500]);
    expectApprox(twr(s), 0.1);
  });

  it("missing FX makes days incomplete and returns link over them", () => {
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", {
        instrument: "U",
        quantity: "10",
        price: "25",
        currency: USD,
        cashCurrency: PLN,
      }),
    ];
    const closes = {
      "2025-01-02": "25",
      "2025-01-03": "25",
      "2025-01-04": "26",
      "2025-01-05": 27.5,
    };
    const s = seriesOf(
      txns,
      [instrument("U", USD)],
      { U: bars("U", closes) },
      rates(USD, { "2025-01-05": "4.0" }), // nothing before 01-05
    );
    const c = combineSeries(s);
    expect(c.complete).toEqual([true, false, false, false, true]);
    expectApprox(c.values[c.values.length - 1], 1100);
    // capital 1000 (the deposit, carried over the unvalued days) grew to 1100
    expectApprox(twr(s), 0.1);
  });

  it("stale FX beyond the limit is incomplete", () => {
    const txns = [txn("deposit", "2025-01-02", "100", { currency: EUR })];
    const s = seriesOf(txns, [], {}, rates(EUR, { "2025-01-01": "4.3" }), "2025-01-20", {
      policy: { maxPriceAgeDays: 5, maxFxAgeDays: 10 },
    });
    const c = combineSeries(s);
    expect(approxEq(c.values[1], 430, {}) && c.complete[1]).toBe(true);
    // on 01-11 the rate is 10 days old, then 11
    expect(c.complete[10] && !c.complete[11]).toBe(true);
  });

  it("cost-mode holding keeps its lots and is valued at cost", () => {
    const bond = instrument("BOND", PLN, AssetClass.TREASURY_BOND);
    expect(bond.valuationMode).toBe(ValuationMode.COST);
    const txns = [
      txn("deposit", "2025-01-02", "1000"),
      txn("buy", "2025-01-02", "-1000", { instrument: "BOND", quantity: "10", price: "100" }),
    ];
    const s = seriesOf(txns, [bond], {}, [], "2025-01-03");
    expectApproxList(values(s), [0, 1000, 1000]);
    expect(combineSeries(s).complete.every(Boolean)).toBe(true);
  });

  // ------------------------------------------------------------------------- //
  // Incremental snapshots == build_snapshot; series value == the public pipeline
  // ------------------------------------------------------------------------- //

  function mixedHistory() {
    const txns = [
      txn("deposit", "2025-01-02", "20000", { account: "1" }),
      txn("deposit", "2025-01-02", "5000", { account: "2" }),
      txn("buy", "2025-01-03", "-3000", {
        account: "1",
        instrument: "A",
        quantity: "30",
        price: "100",
      }),
      txn("buy", "2025-01-03", "-4300", {
        account: "1",
        instrument: "E",
        quantity: "10",
        price: "100",
        currency: EUR,
        cashCurrency: PLN,
      }),
      txn("buy", "2025-01-06", "-1000", {
        account: "2",
        instrument: "A",
        quantity: "10",
        price: "100",
      }),
      txn("buy", "2025-01-08", "-1500", {
        account: "1",
        instrument: "A",
        quantity: "12",
        price: "125",
      }),
      txn("sell", "2025-01-10", "1400", {
        account: "1",
        instrument: "A",
        quantity: "10",
        price: "140",
      }),
      txn("dividend", "2025-01-12", "50", { account: "1", instrument: "E" }),
      txn("fee", "2025-01-13", "-7", { account: "2" }),
      txn("buy", "2025-01-14", "-1000", {
        account: "2",
        instrument: "BOND",
        quantity: "10",
        price: "100",
      }),
      txn("sell", "2025-01-20", "4200", {
        account: "1",
        instrument: "A",
        quantity: "32",
        price: "131.25",
      }),
      txn("buy", "2025-01-21", "-600", {
        account: "1",
        instrument: "OLD",
        quantity: "6",
        price: "100",
      }),
      txn("transfer_out", "2025-01-24", "0", { account: "2", instrument: "A", quantity: "4" }),
    ];
    const renames = [
      instrumentRename({
        date: day("2025-01-23"),
        oldInstrumentId: asInstrumentId("OLD"),
        newInstrumentId: asInstrumentId("NEW"),
      }),
    ];
    const insts = [
      instrument("A"),
      instrument("E", EUR),
      instrument("BOND", PLN, AssetClass.TREASURY_BOND),
      instrument("OLD"),
      instrument("NEW"),
    ];
    // Python ints (`100 + i`) render without a fraction, floats (`100 + i * 0.5`) with one
    const a = Object.fromEntries(
      days("2025-01-01", "2025-01-31").map((d, i) => [d, String(100 + i)]),
    );
    const e = Object.fromEntries(
      days("2025-01-01", "2025-01-31").map((d, i) => [d, 100 + i * 0.5]),
    );
    const n = Object.fromEntries(
      days("2025-01-22", "2025-01-31").map((d, i) => [d, String(90 + i)]),
    );
    const o = Object.fromEntries(days("2025-01-20", "2025-01-22").map((d) => [d, "100"]));
    const barMap = barMapOf({
      A: bars("A", a),
      E: bars("E", e),
      NEW: bars("NEW", n),
      OLD: bars("OLD", o),
    });
    const fx = rates(
      EUR,
      Object.fromEntries(
        days("2024-12-30", "2025-01-31").map((d, i) => [d, floatRepr(4.3 + i / 100)]),
      ),
    );
    return { txns, renames, insts, barMap, fx };
  }

  it("snapshot stream equals buildSnapshot on every day", () => {
    const { txns, renames } = mixedHistory();
    const sorted = [...txns].sort((x, y) =>
      x.tradeDate !== y.tradeDate
        ? x.tradeDate < y.tradeDate
          ? -1
          : 1
        : x.id < y.id
          ? -1
          : x.id > y.id
            ? 1
            : 0,
    );
    const stream = new SnapshotStream(sorted, renames);
    const holdingRows = (snapshot: ReturnType<typeof buildSnapshot>) =>
      snapshot.holdings.map((h) => [
        h.accountId,
        h.instrumentId,
        decimalKey(h.quantity),
        h.lots.map((l) => [
          l.accountId,
          l.instrumentId,
          l.openTxnId,
          l.openDate,
          decimalKey(l.quantity),
          l.currency,
          l.unitCost === null ? null : decimalKey(l.unitCost),
        ]),
      ]);
    const cashRows = (snapshot: ReturnType<typeof buildSnapshot>) =>
      snapshot.cash.map((c) => [c.accountId, c.currency, decimalKey(c.amount)]);
    for (const d of days("2025-01-01", "2025-01-31")) {
      stream.advance(d);
      const expected = buildSnapshot(asProfileId(""), txns, d, { renames });
      const got = stream.snapshot;
      expect(holdingRows(got), d).toEqual(holdingRows(expected));
      expect(cashRows(got), d).toEqual(cashRows(expected));
    }
  });

  it("series value equals the public pipeline every day", () => {
    const { txns, renames, insts, barMap, fx: fxRates } = mixedHistory();
    const fx = new InMemoryFxLookup(fxRates);
    const instruments = instrumentMap(insts);
    const s = buildSeries(txns, {
      instruments,
      bars: barMap,
      fx,
      base: PLN,
      end: day("2025-01-31"),
      renames,
    });
    s.dates.forEach((d, i) => {
      const snapshot = buildSnapshot(asProfileId(""), txns, d, { renames });
      const view = marketView({
        asOf: d,
        instruments,
        bars: new Map([...barMap].map(([k, v]) => [k, v.filter((b) => b.date <= d)])),
      });
      const valued = valuePortfolio(snapshot, view, fx, PLN, 5);
      for (const account of ["1", "2"].map(asAccountId)) {
        let held = ZERO;
        for (const v of valued.valued) {
          if (v.holding.accountId === account && v.marketValueBase !== null) {
            held = held.add(v.marketValueBase);
          }
        }
        let cash = ZERO;
        for (const c of valued.cash) {
          if (c.cash.accountId === account) cash = cash.add(countedBase(c));
        }
        const expected = held.add(cash);
        const got = s.accounts.get(account)?.values[i] as Decimal;
        expect(got.eq(expected), `${d} ${account}`).toBe(true);
      }
    });
    // the transfer out of account 2 is a withdrawal at that day's close of A
    const closeA = (barMap.get(asInstrumentId("A")) as PriceBar[])[23]?.close.toFloat() as number;
    const flow = s.accounts.get(asAccountId("2"))?.flows[seriesIndexOf(s, day("2025-01-24"))];
    expectApprox(flow?.toFloat(), -4 * closeA);
  });

  it("captures hold per-holding values", () => {
    const { txns, renames, insts, barMap, fx: fxRates } = mixedHistory();
    const end = day("2025-01-31");
    const s = buildSeries(txns, {
      instruments: instrumentMap(insts),
      bars: barMap,
      fx: new InMemoryFxLookup(fxRates),
      base: PLN,
      end,
      renames,
      captureDates: new Set<CalendarDate>([end, day("2025-01-09")]),
    });
    const atEnd = s.captures.get(end);
    const key = (a: string, i: string) => holdingKey(asAccountId(a), asInstrumentId(i));
    // the rename carried the lot
    expect(atEnd?.has(key("1", "NEW")) && !atEnd.has(key("1", "OLD"))).toBe(true);
    expect(atEnd?.get(key("2", "BOND"))?.value?.eq(D("1000"))).toBe(true); // at cost
    const closeA8 = (barMap.get(asInstrumentId("A")) as PriceBar[])[8]?.close as Decimal;
    const at9 = s.captures.get(day("2025-01-09"))?.get(key("1", "A"))?.value;
    expect(at9?.eq(D("42").mul(closeA8))).toBe(true);
  });

  it("empty history", () => {
    const s = seriesOf([], [], {}, [], "2025-01-05");
    expect(s.dates).toEqual(["2025-01-05"]);
    expect(s.accounts.size).toBe(0);
  });
});
