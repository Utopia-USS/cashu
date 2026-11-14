/**
 * Splits are exact: ratios like 1:3 or 1:15 have no finite decimal, so they are read as fractions and lot
 * quantities are exact (regression: a 1:3 split left a 3.0E-19 HistoryGap on a later full sell).
 * Synthetic data only. `norm` turns every Decimal into its value key so `toEqual` compares by value.
 */
import { describe, expect, it } from "vitest";
import { Decimal, decimalKey, sum } from "../../decimal.js";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  datedPrice,
  historyGap,
  lotCostBasis,
} from "../domain/index.js";
import { Fraction } from "./fraction.js";
import { lastTradePrices } from "./lastTradePrices.js";
import { type LotEngineResult, runLots, SPLIT_REMAINDER_TOLERANCE } from "./lotEngine.js";
import { buildSnapshot } from "./snapshotBuilder.js";
import { splitFraction } from "./splitRatio.js";
import { buy, d, newId, PLN, sell, split, transferOut } from "./testing/fixtures.js";

const ACC = newId();
const OTHER = newId();
const X = newId();

const ONE_FOR_THREE = [
  "0.3333333333", // 10 places
  "0.33333333333333333333", // 20 places: the real broker history (3.0E-19 gap on 90 shares)
];
const ONE_FOR_FIFTEEN = ["0.0666666667", "0.0666666666"]; // rounded and truncated

function realizedPnl(result: LotEngineResult): Decimal {
  return sum(result.realized.map((trade) => trade.pnl as Decimal));
}

/** Deep copy with decimals as value keys (Python `Decimal.__eq__`) and sets as sorted arrays. */
function norm(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Decimal) return `D:${decimalKey(value)}`;
  if (value instanceof Set) return [...value].map(norm).sort();
  if (Array.isArray(value)) return value.map(norm);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v)]));
  }
  return value;
}

function expectSame(actual: unknown, expected: unknown): void {
  expect(norm(actual)).toEqual(norm(expected));
}

const n = (value: number): Decimal => d(value);

describe("split_fraction", () => {
  it.each<[string, Fraction]>([
    ["1.5", Fraction.of(3, 2)],
    ["0.02", Fraction.of(1, 50)],
    ["0.3333333333", Fraction.of(1, 3)],
    ["0.3333333333000", Fraction.of(1, 3)], // padded with zeros
    ["0.6666666666", Fraction.of(2, 3)], // truncated
    ["0.0666666667", Fraction.of(1, 15)],
    ["2.3333333333", Fraction.of(7, 3)],
  ])("split fraction recovers the ratio a decimal stands for (%s)", (ratio, expected) => {
    expect(splitFraction(d(ratio))).toEqual(expected);
  });

  it.each([
    "0.3333", // 3333/10000 is itself a simple enough fraction: taken as written
    "1.0456723", // no simple fraction within its last digit
  ])("split fraction keeps other decimals exactly as written (%s)", (ratio) => {
    expect(splitFraction(d(ratio))).toEqual(Fraction.fromDecimal(d(ratio)));
  });
});

describe("reverse splits", () => {
  it.each(ONE_FOR_THREE)(
    "one for three reverse split then full sell leaves exactly zero (%s)",
    (ratio) => {
      const txns = [
        buy(ACC, X, "2026-01-05", "90", "10"), // cost 900
        split(ACC, X, "2026-02-02", ratio), // 30 units at 30
      ];
      const lots = runLots(txns).openLots;
      expect(lots).toHaveLength(1);
      expectSame([lots[0]?.quantity, lots[0]?.unitCost], [d("30"), d("30")]);

      const result = runLots([...txns, sell(ACC, X, "2026-03-02", "30", "35")]);

      expect(result.warnings).toEqual([]);
      expect(result.openLots).toEqual([]);
      expect(result.realized).toHaveLength(1);
      const [trade] = result.realized;
      expectSame([trade?.quantity, trade?.openUnitCost, trade?.pnl], [d("30"), d("30"), d("150")]);
    },
  );

  it("one for three full sell leaves an empty snapshot", () => {
    const txns = [
      buy(ACC, X, "2026-01-05", "90", "10"),
      split(ACC, X, "2026-02-02", "0.33333333333333333333"),
      sell(ACC, X, "2026-03-02", "30", "35"),
    ];
    const snapshot = buildSnapshot(asProfileId(newId()), txns, "2026-03-31");
    expect(snapshot.holdings).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
  });

  it.each(ONE_FOR_FIFTEEN)(
    "chained one for fifteen and one for fifty with cash in lieu close exactly (%s)",
    (ratio) => {
      const txns = [
        buy(ACC, X, "2026-01-05", "1002", "2"), // cost 2004
        split(ACC, X, "2026-02-02", ratio), // 66.8 units at 30
        sell(ACC, X, "2026-02-03", "0.8", "31"), // cash in lieu: proceeds 24.8, cost 24
      ];
      expectSame(
        runLots(txns).openLots.map((lot) => lot.quantity),
        [d("66")],
      );

      txns.push(
        split(ACC, X, "2026-03-02", "0.02"), // 1:50 -> 1.32 units at 1500
        sell(ACC, X, "2026-03-03", "0.32", "1600"), // cash in lieu: proceeds 512, cost 480
      );
      const lots = runLots(txns).openLots;
      expect(lots).toHaveLength(1);
      expectSame([lots[0]?.quantity, lots[0]?.unitCost], [d("1"), d("1500")]);

      const result = runLots([...txns, sell(ACC, X, "2026-04-01", "1", "1600")]);

      expect(result.warnings).toEqual([]);
      expect(result.openLots).toEqual([]);
      expectSame(
        result.realized.map((trade) => trade.pnl),
        [d("0.8"), d("32"), d("100")],
      );
      // all proceeds - all cost
      expect(realizedPnl(result).eq(d("2136.8").sub(d("2004")))).toBe(true);
    },
  );

  it("cash in lieu of a fraction with no finite decimal leaves whole shares", () => {
    const txns = [
      buy(ACC, X, "2026-01-05", "1000", "1"), // cost 1000
      split(ACC, X, "2026-02-02", "0.0666666667"), // 1:15 -> 200/3 units at 15
    ];
    let lots = runLots(txns).openLots;
    expect(lots).toHaveLength(1);
    // reported with 20 significant digits
    expect(lots[0]?.quantity.eq(d("66.666666666666666667"))).toBe(true);
    expect(lots[0]?.unitCost?.eq(d("15"))).toBe(true);

    // The broker sells the fraction (2/3 unit) as a rounded decimal: the lot keeps exactly 66 units.
    txns.push(sell(ACC, X, "2026-02-03", "0.6666666667", "15"));
    let result = runLots(txns);
    lots = result.openLots;
    expect(lots).toHaveLength(1);
    expectSame([lots[0]?.quantity, lots[0]?.unitCost], [d("66"), d("15")]);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expectSame([trade?.quantity, trade?.openUnitCost], [d("0.6666666667"), d("15")]);
    // cost of exactly 2/3 unit
    expect(trade?.pnl?.eq(d("0.6666666667").mul(n(15)).sub(n(10)))).toBe(true);

    txns.push(
      split(ACC, X, "2026-03-02", "0.02"), // 1.32 units at 750
      sell(ACC, X, "2026-03-03", "0.32", "800"),
      sell(ACC, X, "2026-04-01", "1", "800"),
    );
    result = runLots(txns);
    expect(result.warnings).toEqual([]);
    expect(result.openLots).toEqual([]);
    const proceeds = d("0.6666666667")
      .mul(n(15))
      .add(d("0.32").mul(n(800)))
      .add(n(800));
    expect(realizedPnl(result).eq(proceeds.sub(n(1000)))).toBe(true);
  });

  it.each(["0.4666666667", "0.4666666666"])(
    "a whole position with no finite decimal is closed by the brokers decimal (%s)",
    (quantity) => {
      const txns = [
        buy(ACC, X, "2026-01-05", "7", "10"), // cost 70
        split(ACC, X, "2026-02-02", "0.0666666667"), // 7/15 units at 150
      ];
      const sold = runLots([...txns, sell(ACC, X, "2026-03-02", quantity, "160")]);
      expect(sold.warnings).toEqual([]);
      expect(sold.openLots).toEqual([]);
      expect(sold.realized).toHaveLength(1);
      const [trade] = sold.realized;
      expect(trade?.quantity.eq(d(quantity))).toBe(true);
      expect(trade?.openUnitCost?.eq(d("150"))).toBe(true);
      // the whole exact cost is released
      expect(trade?.pnl?.eq(d(quantity).mul(n(160)).sub(n(70)))).toBe(true);

      const moved = runLots([...txns, transferOut(ACC, X, "2026-03-02", quantity)]);
      expect(moved.warnings).toEqual([]);
      expect(moved.openLots).toEqual([]);
    },
  );

  it("split dust tolerance is tiny and explicit", () => {
    expect(Fraction.of(1n, 10n ** 9n).eq(SPLIT_REMAINDER_TOLERANCE)).toBe(true);
    const txns = [
      buy(ACC, X, "2026-01-05", "7", "10"),
      split(ACC, X, "2026-02-02", "0.0666666667"), // 7/15 = 0.4666...
    ];

    // 6.7E-10 left: within the tolerance, the lot is closed.
    expect(runLots([...txns, sell(ACC, X, "2026-03-02", "0.4666666660", "160")]).openLots).toEqual(
      [],
    );

    // 1.7E-9 left: beyond it, the dust stays visible.
    const lots = runLots([...txns, sell(ACC, X, "2026-03-02", "0.466666665", "160")]).openLots;
    expect(lots).toHaveLength(1);
    expect(lots[0]?.quantity.eq(d("1.6666666666666666667E-9"))).toBe(true);

    // Sold 3.3E-7 too much at 6 places: a history gap, not silently forgiven.
    const over = sell(ACC, X, "2026-03-02", "0.466667", "160");
    const result = runLots([...txns, over]);
    expect(result.openLots).toEqual([]);
    expectSame(result.warnings, [
      historyGap({
        accountId: asAccountId(ACC),
        instrumentId: asInstrumentId(X),
        date: "2026-03-02",
        shortfall: d("3.3333333333333333333E-7"),
        txnId: over.id,
      }),
    ]);
  });

  it("remainders with a finite decimal are never snapped", () => {
    const lots = runLots([
      buy(ACC, X, "2026-01-05", "1", "10"),
      sell(ACC, X, "2026-02-02", "0.9999999999", "11"),
    ]).openLots;
    expect(lots).toHaveLength(1);
    expect(lots[0]?.quantity.eq(d("1E-10"))).toBe(true);

    const over = sell(ACC, X, "2026-02-02", "1.0000000001", "11");
    const result = runLots([buy(ACC, X, "2026-01-05", "1", "10"), over]);
    expectSame(
      result.warnings.map((w) => [
        w.kind === "history_gap" ? w.txnId : w.kind,
        w.kind === "history_gap" ? w.shortfall : null,
      ]),
      [[over.id, d("1E-10")]],
    );
  });
});

describe("forward splits", () => {
  it("three for one and two for one forward splits keep the cost and close exactly", () => {
    const txns = [
      buy(ACC, X, "2026-01-05", "7", "33", { fee: "1" }), // cost 232
      split(ACC, X, "2026-02-02", "3"), // 21 units
      split(ACC, X, "2026-03-02", "2"), // 42 units
    ];
    const lots = runLots(txns).openLots;
    expect(lots).toHaveLength(1);
    expect(lots[0]?.quantity.eq(d("42"))).toBe(true);
    expect(lots[0]?.unitCost?.eq(d("5.5238095238"))).toBe(true); // 232 / 42, rounded only for display

    const result = runLots([
      ...txns,
      sell(ACC, X, "2026-04-01", "21", "6"),
      sell(ACC, X, "2026-04-02", "21", "6"),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.openLots).toEqual([]);
    // 126 - 116 each
    expectSame(
      result.realized.map((trade) => trade.pnl),
      [d("10"), d("10")],
    );
  });

  it("three for two split of an odd quantity", () => {
    const txns = [buy(ACC, X, "2026-01-05", "7", "15"), split(ACC, X, "2026-02-02", "1.5")];
    const lots = runLots(txns).openLots;
    expect(lots).toHaveLength(1);
    expectSame([lots[0]?.quantity, lots[0]?.unitCost], [d("10.5"), d("10")]);
    const result = runLots([...txns, sell(ACC, X, "2026-03-02", "10.5", "12")]);
    expect([result.warnings, result.openLots]).toEqual([[], []]);
    expect(realizedPnl(result).eq(d("21"))).toBe(true);
  });
});

describe("cost basis", () => {
  it("splits leave the total cost basis unchanged", () => {
    const txns = [
      buy(ACC, X, "2026-01-05", "30", "10"), // cost 300
      buy(ACC, X, "2026-01-06", "60", "12", { fee: "3" }), // cost 723
    ];

    const costBasis = (history: typeof txns): Decimal =>
      sum(runLots(history).openLots.map((lot) => lotCostBasis(lot) as Decimal));

    expect(costBasis(txns).eq(d("1023"))).toBe(true);
    txns.push(split(ACC, X, "2026-02-02", "0.3333333333")); // 10 at 30, 20 at 36.15
    expectSame(
      runLots(txns).openLots.map((lot) => [lot.quantity, lot.unitCost]),
      [
        [d("10"), d("30")],
        [d("20"), d("36.15")],
      ],
    );
    expect(costBasis(txns).eq(d("1023"))).toBe(true);
    txns.push(split(ACC, X, "2026-03-02", "3")); // back to 30 at 10, 60 at 12.05
    expect(costBasis(txns).eq(d("1023"))).toBe(true);

    const result = runLots([...txns, sell(ACC, X, "2026-04-01", "90", "13")]);
    expect([result.warnings, result.openLots]).toEqual([[], []]);
    expect(realizedPnl(result).eq(d("1170").sub(d("1023")))).toBe(true);
  });
});

describe("last trade prices", () => {
  it("last trade price divides by the exact fraction and dedups by it", () => {
    const txns = [
      buy(ACC, X, "2026-01-05", "3", "10"),
      buy(OTHER, X, "2026-01-05", "3", "10"),
      split(ACC, X, "2026-02-02", "0.3333333333"),
      // The same 1:3 split booked two days later in another account, written with more digits.
      split(OTHER, X, "2026-02-04", "0.33333333333333333333"),
    ];
    expectSame(
      lastTradePrices(txns).get(asInstrumentId(X)),
      datedPrice({ date: "2026-01-05", price: d("30"), currency: PLN }),
    );
  });
});
