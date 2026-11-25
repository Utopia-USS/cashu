/**
 * FIFO lot engine, plus splits, transfers, history gaps, cash and renames. Synthetic data only.
 * `norm` turns every Decimal into its value key so `toEqual` compares by value.
 */
import { describe, expect, it } from "vitest";
import { Decimal, decimalKey, localContext, makeContext, sum } from "../../decimal.js";
import {
  asAccountId,
  asInstrumentId,
  cashBalance,
  datedAmount,
  historyGap,
  instrumentRename,
  lotCostBasis,
  Money,
  openLot,
  realizedHoldingDays,
  realizedTrade,
  TxnSource,
  TxnType,
  transaction,
  unknownCostBasis,
} from "../domain/index.js";
import { asTxnId } from "../domain/values.js";
import { runLots } from "./lotEngine.js";
import {
  buildTxn,
  buy,
  cashTxn,
  d,
  newId,
  PLN,
  sell,
  split,
  transferIn,
  transferOut,
  USD,
} from "./testing/fixtures.js";

const ACC = newId();
const OTHER = newId();
const X = newId();
const Y = newId();

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

const acc = asAccountId;
const ins = asInstrumentId;

describe("FIFO", () => {
  it("partial sell consumes oldest lot first and splits the next", () => {
    const buy1 = buy(ACC, X, "2026-01-05", "10", "100", { fee: "5" }); // cost 1005, unit 100.5
    const buy2 = buy(ACC, X, "2026-02-02", "10", "120", { fee: "5" }); // cost 1205, unit 120.5
    const sale = sell(ACC, X, "2026-03-02", "15", "130", { fee: "6" }); // proceeds 1950 - 6 = 1944

    const result = runLots([sale, buy2, buy1]); // input order does not matter

    expect(result.warnings).toEqual([]);
    expectSame(result.realized, [
      realizedTrade({
        accountId: acc(ACC),
        instrumentId: ins(X),
        openTxnId: buy1.id,
        closeTxnId: sale.id,
        openDate: "2026-01-05",
        closeDate: "2026-03-02",
        quantity: d("10"),
        openUnitCost: d("100.5"),
        closeUnitPrice: d("129.6"),
        currency: PLN,
        pnl: d("291"), // 1944 * 10/15 = 1296 - 1005
      }),
      realizedTrade({
        accountId: acc(ACC),
        instrumentId: ins(X),
        openTxnId: buy2.id,
        closeTxnId: sale.id,
        openDate: "2026-02-02",
        closeDate: "2026-03-02",
        quantity: d("5"),
        openUnitCost: d("120.5"),
        closeUnitPrice: d("129.6"),
        currency: PLN,
        pnl: d("45.5"), // 1944 - 1296 = 648 - 1205 * 5/10
      }),
    ]);
    expect(result.realized.map(realizedHoldingDays)).toEqual([56, 28]);
    expectSame(result.openLots, [
      openLot({
        accountId: acc(ACC),
        instrumentId: ins(X),
        openTxnId: buy2.id,
        openDate: "2026-02-02",
        quantity: d("5"),
        unitCost: d("120.5"),
        currency: PLN,
      }),
    ]);
  });

  it("rounded partial costs never lose money", () => {
    const lot = buy(ACC, X, "2026-01-05", "3", "100", { fee: "1" }); // cost 301
    const first = sell(ACC, X, "2026-02-02", "1", "110");
    const rest = sell(ACC, X, "2026-03-02", "2", "110");

    const afterFirst = runLots([lot, first]);
    expect(afterFirst.realized).toHaveLength(1);
    const [trade] = afterFirst.realized;
    expect(trade?.openUnitCost?.eq(d("100.3333333333"))).toBe(true);
    expect(trade?.pnl?.eq(d("9.6666666667"))).toBe(true); // 110 - 301/3 rounded
    expect(afterFirst.openLots).toHaveLength(1);
    const [openLotAfter] = afterFirst.openLots;
    expect(openLotAfter?.quantity.eq(d("2"))).toBe(true);
    expect(openLotAfter?.unitCost?.eq(d("100.3333333334"))).toBe(true); // 200.6666666667 / 2

    const result = runLots([lot, first, rest]);
    expect(result.openLots).toEqual([]);
    // 330 proceeds - 301 cost, exact
    expect(sum(result.realized.map((t) => t.pnl as Decimal)).eq(d("29"))).toBe(true);
  });

  it("fees and taxes go into cost on buys and reduce proceeds on sells", () => {
    const result = runLots([
      buy(ACC, X, "2026-01-05", "10", "50", { fee: "2", tax: "3" }), // cost 505
      sell(ACC, X, "2026-02-02", "10", "60", { fee: "2", tax: "4" }), // proceeds 594
    ]);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.openUnitCost?.eq(d("50.5"))).toBe(true);
    expect(trade?.closeUnitPrice.eq(d("59.4"))).toBe(true);
    expect(trade?.pnl?.eq(d("89"))).toBe(true);
    expectSame(result.cash, [cashBalance({ accountId: acc(ACC), currency: PLN, amount: d("89") })]);
  });

  it("same day transactions keep their created at order", () => {
    const morningBuy = buy(ACC, X, "2026-01-05", "10", "100");
    const eveningSell = sell(ACC, X, "2026-01-05", "10", "110");

    expect(runLots([eveningSell, morningBuy]).warnings).toEqual([]);
    // The same rows with the sell created first: the sell has nothing to match.
    const sellFirst = {
      ...eveningSell,
      createdAt: {
        date: "2025-01-01",
        hour: 0,
        minute: 0,
        second: 0,
        microsecond: 0,
        offsetSeconds: 0,
      },
    };
    const warnings = runLots([sellFirst, morningBuy]).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("history_gap");
  });

  it("naive and aware created at can be mixed", () => {
    const morningBuy = {
      ...buy(ACC, X, "2026-01-05", "10", "100"),
      createdAt: {
        date: "2026-01-05",
        hour: 9,
        minute: 0,
        second: 0,
        microsecond: 0,
        offsetSeconds: null,
      },
    };
    const eveningSell = {
      ...sell(ACC, X, "2026-01-05", "10", "110"),
      createdAt: {
        date: "2026-01-05",
        hour: 15,
        minute: 0,
        second: 0,
        microsecond: 0,
        offsetSeconds: 0,
      },
    };
    expect(runLots([eveningSell, morningBuy]).warnings).toEqual([]);
  });

  it("instruments are matched separately", () => {
    const result = runLots([
      buy(ACC, X, "2026-01-05", "10", "100"),
      buy(ACC, Y, "2026-01-06", "4", "25"),
      sell(ACC, Y, "2026-02-02", "4", "30"),
    ]);
    expect(result.openLots[0]?.instrumentId).toBe(X);
    expect(result.openLots).toHaveLength(1);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.instrumentId).toBe(Y);
    expect(trade?.pnl?.eq(d("20"))).toBe(true);
  });
});

describe("multiple accounts", () => {
  it("lots cash and gaps are kept per account", () => {
    const result = runLots([
      cashTxn(ACC, "2026-01-02", "2000"),
      cashTxn(OTHER, "2026-01-02", "1500"),
      buy(ACC, X, "2026-01-05", "10", "100"),
      buy(OTHER, X, "2026-01-05", "5", "200"),
      sell(ACC, X, "2026-02-02", "12", "110"), // account ACC holds only 10
    ]);
    expect(result.openLots).toHaveLength(1);
    const [lot] = result.openLots;
    expect(lot?.accountId).toBe(OTHER);
    expect(lot?.quantity.eq(d("5"))).toBe(true);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.quantity.eq(d("10"))).toBe(true);
    expect(trade?.pnl?.eq(d("100"))).toBe(true); // 1320 * 10/12 = 1100 - 1000
    expect(result.warnings).toHaveLength(1);
    const gap = result.warnings[0];
    expect(gap?.kind).toBe("history_gap");
    if (gap?.kind !== "history_gap") return;
    expect(gap.accountId).toBe(ACC);
    expect(gap.shortfall.eq(d("2"))).toBe(true);
    expectSame(result.cash, [
      cashBalance({ accountId: acc(ACC), currency: PLN, amount: d("2320") }), // 2000 - 1000 + 1320
      cashBalance({ accountId: acc(OTHER), currency: PLN, amount: d("500") }),
    ]);
  });

  it("the account filter keeps only the given accounts", () => {
    const result = runLots(
      [buy(ACC, X, "2026-01-05", "10", "100"), buy(OTHER, X, "2026-01-05", "5", "200")],
      { accountIds: new Set([acc(OTHER)]) },
    );
    expect(result.openLots.map((lot) => lot.accountId)).toEqual([OTHER]);
    expect(result.cash.map((c) => c.accountId)).toEqual([OTHER]);
  });
});

describe("splits", () => {
  it("split multiplies open quantities and divides unit cost", () => {
    const result = runLots([
      buy(ACC, X, "2026-01-05", "10", "400"), // cost 4000
      split(ACC, X, "2026-02-02", "4"), // 40 units at 100
      sell(ACC, X, "2026-03-02", "20", "120"), // proceeds 2400, cost 2000
    ]);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.openUnitCost?.eq(d("100"))).toBe(true);
    expect(trade?.pnl?.eq(d("400"))).toBe(true);
    expect(result.openLots).toHaveLength(1);
    const [lot] = result.openLots;
    expect(lot?.quantity.eq(d("20"))).toBe(true);
    expect(lot?.unitCost?.eq(d("100"))).toBe(true);
    expect(lot?.openDate).toBe("2026-01-05");
  });

  it("reverse split touches only its account", () => {
    const result = runLots([
      buy(ACC, X, "2026-01-05", "10", "10"),
      buy(OTHER, X, "2026-01-05", "10", "10"),
      split(ACC, X, "2026-02-02", "0.5"),
    ]);
    expectSame(
      result.openLots.map((lot) => [lot.accountId, lot.quantity, lot.unitCost]),
      [
        [ACC, d("5"), d("20")],
        [OTHER, d("10"), d("10")],
      ],
    );
  });

  it("split without a ratio is ignored with a warning", () => {
    const bad = { ...split(ACC, X, "2026-02-02", "4"), splitRatio: d("0") };
    const result = runLots([buy(ACC, X, "2026-01-05", "10", "10"), bad]);
    expect(result.openLots[0]?.quantity.eq(d("10"))).toBe(true);
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    expect(warning?.kind).toBe("invalid_transaction");
    if (warning?.kind !== "invalid_transaction") return;
    expect(warning.txnId).toBe(bad.id);
  });
});

describe("transfers", () => {
  it("transfer in without price opens a lot with unknown cost", () => {
    const incoming = transferIn(ACC, X, "2026-01-05", "10");
    const sale = sell(ACC, X, "2026-02-02", "4", "50");

    const result = runLots([incoming, sale]);

    expectSame(result.warnings, [
      unknownCostBasis({
        accountId: acc(ACC),
        instrumentId: ins(X),
        txnId: incoming.id,
        date: "2026-01-05",
      }),
    ]);
    expect(result.openLots).toHaveLength(1);
    const lot = result.openLots[0];
    expect(lot?.quantity.eq(d("6"))).toBe(true);
    expect(lot?.unitCost).toBeNull();
    expect(lot && lotCostBasis(lot)).toBeNull();
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.openUnitCost).toBeNull();
    expect(trade?.pnl).toBeNull();
    expect(trade?.closeUnitPrice.eq(d("50"))).toBe(true);
  });

  it("transfer in with price uses it as cost and zero counts as unknown", () => {
    const priced = runLots([transferIn(ACC, X, "2026-01-05", "10", { price: "80" })]);
    expect(priced.warnings).toEqual([]);
    expect(priced.openLots[0]?.unitCost?.eq(d("80"))).toBe(true);

    const zero = runLots([transferIn(ACC, X, "2026-01-05", "10", { price: "0" })]);
    expect(zero.warnings).toHaveLength(1);
    expect(zero.warnings[0]?.kind).toBe("unknown_cost_basis");
    expect(zero.openLots[0]?.unitCost).toBeNull();
  });

  it("transfer out consumes fifo without realizing", () => {
    const result = runLots([
      buy(ACC, X, "2026-01-05", "10", "100"),
      buy(ACC, X, "2026-01-06", "10", "200"),
      transferOut(ACC, X, "2026-02-02", "12"),
    ]);
    expect(result.realized).toEqual([]);
    expect(result.openLots).toHaveLength(1);
    const [lot] = result.openLots;
    expect(lot?.quantity.eq(d("8"))).toBe(true);
    expect(lot?.unitCost?.eq(d("200"))).toBe(true);
  });

  it("adjustment adds units like a transfer in", () => {
    const adjustment = {
      ...transferIn(ACC, X, "2026-01-05", "3"),
      type: TxnType.ADJUSTMENT,
      source: TxnSource.RECONCILIATION,
    };
    const result = runLots([adjustment]);
    expect(result.openLots[0]?.quantity.eq(d("3"))).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe("unknown_cost_basis");
  });
});

describe("incomplete history", () => {
  it("selling more than held records history gap and never raises", () => {
    const lot = buy(ACC, X, "2026-01-05", "5", "8"); // cost 40
    const sale = sell(ACC, X, "2026-02-02", "8", "10"); // proceeds 80, 50 for the 5 matched units

    const result = runLots([lot, sale]);

    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.quantity.eq(d("5"))).toBe(true);
    expect(trade?.pnl?.eq(d("10"))).toBe(true);
    expect(result.openLots).toEqual([]);
    expectSame(result.warnings, [
      historyGap({
        accountId: acc(ACC),
        instrumentId: ins(X),
        date: "2026-02-02",
        shortfall: d("3"),
        txnId: sale.id,
      }),
    ]);
    // -40 + 80: cash follows cash_amount regardless
    expect(result.cash[0]?.amount.eq(d("40"))).toBe(true);
  });

  it("selling with nothing held and transferring out too much are gaps", () => {
    const result = runLots([
      sell(ACC, X, "2026-01-05", "8", "10"),
      buy(ACC, Y, "2026-01-05", "1", "10"),
      transferOut(ACC, Y, "2026-01-06", "3"),
    ]);
    expect(result.realized).toEqual([]);
    expect(result.openLots).toEqual([]);
    expectSame(
      result.warnings.map((w) => (w.kind === "history_gap" ? w.shortfall : w.kind)),
      [d("8"), d("2")],
    );
  });

  it("rows missing instrument or quantity skip lots but count for cash", () => {
    const noQuantity = buildTxn(ACC, X, {
      type: TxnType.SELL,
      quantity: null,
      grossAmount: "50",
      cashAmount: "50",
    });
    const orphan = transaction({
      id: asTxnId(newId()),
      accountId: acc(ACC),
      type: TxnType.BUY,
      tradeDate: "2026-01-06",
      quantity: d("1"),
      price: d("10"),
      currency: PLN,
      grossAmount: d("10"),
      cashAmount: d("-10"),
      cashCurrency: PLN,
      source: TxnSource.MANUAL,
    });

    const result = runLots([noQuantity, orphan]);

    expect(result.openLots).toEqual([]);
    expect(
      result.warnings.map((w) => (w.kind === "invalid_transaction" ? w.reason : w.kind)),
    ).toEqual(["missing or zero quantity", "missing instrument"]);
    expect(result.cash[0]?.amount.eq(d("40"))).toBe(true);
  });
});

describe("cash and deposits", () => {
  it("cash per currency deposits oldest first zero balances dropped", () => {
    const result = runLots([
      cashTxn(ACC, "2026-02-01", "500"),
      cashTxn(ACC, "2026-01-01", "1000"),
      cashTxn(ACC, "2026-01-15", "200", { currency: USD }),
      cashTxn(ACC, "2026-01-20", "-200", { type: TxnType.WITHDRAWAL, currency: USD }),
      cashTxn(ACC, "2026-01-21", "12.5", { type: TxnType.DIVIDEND }),
      cashTxn(ACC, "2026-01-22", "-2.5", { type: TxnType.FEE }),
    ]);
    expectSame(result.cash, [
      cashBalance({ accountId: acc(ACC), currency: PLN, amount: d("1510") }),
    ]);
    expectSame(result.deposits, [
      datedAmount({ accountId: acc(ACC), date: "2026-01-01", amount: new Money(d("1000"), PLN) }),
      datedAmount({ accountId: acc(ACC), date: "2026-01-15", amount: new Money(d("200"), USD) }),
      datedAmount({ accountId: acc(ACC), date: "2026-02-01", amount: new Money(d("500"), PLN) }),
    ]);
  });

  it("foreign buy settled in pln moves pln cash and keeps the lot in usd", () => {
    const usdBuy = {
      ...buy(ACC, X, "2026-01-05", "2", "100", { currency: USD }),
      cashAmount: d("-800"),
      cashCurrency: PLN,
      fxRate: d("4"),
    };
    const result = runLots([usdBuy]);
    expect(result.openLots).toHaveLength(1);
    const [lot] = result.openLots;
    expect(lot?.currency).toBe(USD);
    expect(lot?.unitCost?.eq(d("100"))).toBe(true);
    expectSame(result.cash, [
      cashBalance({ accountId: acc(ACC), currency: PLN, amount: d("-800") }),
    ]);
  });

  it("large amounts stay exact", () => {
    // 18 significant digits per factor: the default 28-digit decimal context would round products.
    const [quantity, buyPrice, sellPrice] = [
      "123456789.123456789",
      "98765432.987654321",
      "98765433.987654321",
    ];
    const { opened, closed } = localContext(makeContext({ prec: 100 }), () => {
      const cost = d(quantity).mul(d(buyPrice));
      const proceeds = d(quantity).mul(d(sellPrice));
      return {
        opened: {
          ...buy(ACC, X, "2026-01-05", "1", "1"),
          quantity: d(quantity),
          price: d(buyPrice),
          grossAmount: cost,
          cashAmount: cost.neg(),
        },
        closed: {
          ...sell(ACC, X, "2026-02-02", "1", "1"),
          quantity: d(quantity),
          price: d(sellPrice),
          grossAmount: proceeds,
          cashAmount: proceeds,
        },
      };
    });

    const result = runLots([opened, closed]);

    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    // (sell - buy price) * quantity, exact to the last digit
    expect(trade?.pnl?.eq(d(quantity))).toBe(true);
    expect(result.cash[0]?.amount.eq(d(quantity))).toBe(true);
  });
});

describe("renames", () => {
  it("rename carries lots with cost and open date to the new instrument", () => {
    const oldBuy = buy(ACC, X, "2026-01-05", "10", "100", { fee: "5" }); // cost 1005
    const otherBuy = buy(OTHER, X, "2026-01-06", "4", "50"); // cost 200
    const rename = instrumentRename({
      date: "2026-03-01",
      oldInstrumentId: ins(X),
      newInstrumentId: ins(Y),
    });
    const laterSale = sell(ACC, Y, "2026-04-01", "4", "120");

    const result = runLots([oldBuy, otherBuy, laterSale], { renames: [rename] });

    expect(result.warnings).toEqual([]);
    expectSame(
      result.openLots.map((lot) => [lot.accountId, lot.instrumentId, lot.quantity, lot.openDate]),
      [
        [ACC, Y, d("6"), "2026-01-05"],
        [OTHER, Y, d("4"), "2026-01-06"],
      ],
    );
    expect(result.openLots[0]?.unitCost?.eq(d("100.5"))).toBe(true);
    expect(result.realized).toHaveLength(1);
    const [trade] = result.realized;
    expect(trade?.instrumentId).toBe(Y);
    expect(trade?.openTxnId).toBe(oldBuy.id);
    expect(trade?.openDate).toBe("2026-01-05");
    expect(trade?.pnl?.eq(d("78"))).toBe(true); // 480 - 4 * 100.5
  });

  it("rows naming the old instrument after a rename count for the new one", () => {
    const rename = instrumentRename({
      date: "2026-03-01",
      oldInstrumentId: ins(X),
      newInstrumentId: ins(Y),
    });
    const result = runLots(
      [
        buy(ACC, X, "2026-01-05", "10", "100"),
        sell(ACC, X, "2026-03-01", "3", "110"), // same day as the rename: already Y
        split(ACC, X, "2026-03-02", "2"),
      ],
      { renames: [rename] },
    );
    expect(result.warnings).toEqual([]);
    expect(result.openLots).toHaveLength(1);
    const lot = result.openLots[0];
    expectSame([lot?.instrumentId, lot?.quantity, lot?.unitCost], [Y, d("14"), d("50")]);
    expect(result.realized[0]?.instrumentId).toBe(Y);
  });

  it("rename merges with lots already held in the new instrument fifo by open date", () => {
    const early = buy(ACC, X, "2026-01-05", "1", "10");
    const middle = buy(ACC, Y, "2026-01-10", "1", "20");
    const late = buy(ACC, X, "2026-01-15", "1", "30");
    const rename = instrumentRename({
      date: "2026-02-01",
      oldInstrumentId: ins(X),
      newInstrumentId: ins(Y),
    });

    const result = runLots([early, middle, late], { renames: [rename] });

    expect(result.openLots.map((lot) => lot.openTxnId)).toEqual([early.id, middle.id, late.id]);
    expect(new Set(result.openLots.map((lot) => lot.instrumentId))).toEqual(new Set([Y]));
  });

  it("chained renames and a rename before any lot", () => {
    const z = newId();
    const result = runLots(
      [buy(ACC, X, "2026-01-05", "2", "10"), sell(ACC, X, "2026-06-01", "1", "12")],
      {
        renames: [
          instrumentRename({
            date: "2026-02-01",
            oldInstrumentId: ins(X),
            newInstrumentId: ins(Y),
          }),
          instrumentRename({
            date: "2026-03-01",
            oldInstrumentId: ins(Y),
            newInstrumentId: ins(z),
          }),
          instrumentRename({
            date: "2025-01-01",
            oldInstrumentId: ins(newId()),
            newInstrumentId: ins(X),
          }),
        ],
      },
    );
    expectSame(
      result.openLots.map((lot) => [lot.instrumentId, lot.quantity]),
      [[z, d("1")]],
    );
    expect(result.realized[0]?.instrumentId).toBe(z);
    expect(result.realized[0]?.pnl?.eq(d("2"))).toBe(true);
  });
});
