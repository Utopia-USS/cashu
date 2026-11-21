/** Snapshot builder, restrictSnapshot and last trade prices (R11, R13). Synthetic data only. */
import { describe, expect, it } from "vitest";
import type { DateTime } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import { TxnSource, TxnType } from "../domain/enums.js";
import { instrumentRename } from "../domain/instrument.js";
import {
  cashBalance,
  datedPrice,
  holdingAverageCost,
  holdingCostBasis,
  holdingsOf,
  portfolioSnapshot,
  realizedPnlByCurrency,
} from "../domain/snapshot.js";
import { asProfileId } from "../domain/values.js";
import { cashHistoryGap, missingInstrument, mixedLotCurrencies } from "../domain/warnings.js";
import { buildSnapshot, lastTradePrices, restrictSnapshot } from "./index.js";
import {
  acc,
  buildTxn,
  buy,
  cashTxn,
  d,
  ins,
  newId,
  PLN,
  sell,
  split,
  transferIn,
  USD,
} from "./testing/fixtures.js";

// Python `Decimal ==` compares by value (`Decimal("100") == Decimal("100.00")`).
expect.addEqualityTesters([
  (a: unknown, b: unknown) => (a instanceof Decimal && b instanceof Decimal ? a.eq(b) : undefined),
]);

const PROFILE = asProfileId(newId());
const IKE = acc(newId());
const REGULAR = acc(newId());
const FOREIGN = acc(newId()); // an account of another profile
const X = ins(newId());
const Y = ins(newId());
const PROFILE_ACCOUNTS = new Set([IKE, REGULAR]);

/** `datetime(2026, 3, 1, tzinfo=UTC)`. */
const MARCH_1_UTC: DateTime = {
  date: "2026-03-01",
  hour: 0,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};

describe("buildSnapshot", () => {
  it("holdings, cash, deposits and realized trades as of a date", () => {
    const txns = [
      cashTxn(IKE, "2026-01-02", "5000"),
      cashTxn(REGULAR, "2026-01-02", "1000"),
      buy(IKE, X, "2026-01-05", "10", "100"),
      buy(IKE, X, "2026-01-20", "10", "110"),
      buy(REGULAR, X, "2026-01-06", "2", "100"),
      buy(IKE, Y, "2026-01-07", "5", "40"),
      sell(IKE, Y, "2026-02-02", "5", "50"), // y fully closed in IKE
      sell(IKE, X, "2026-03-02", "4", "120"),
      buy(IKE, X, "2026-04-01", "100", "1"), // after as_of
    ];

    const snapshot = buildSnapshot(PROFILE, txns, "2026-03-31", {
      profileAccounts: PROFILE_ACCOUNTS,
    });

    expect(snapshot.profileId).toBe(PROFILE);
    expect(snapshot.asOf).toBe("2026-03-31");
    expect(snapshot.holdings.map((h) => [h.accountId, h.instrumentId, h.quantity])).toEqual([
      [IKE, X, d("16")],
      [REGULAR, X, d("2")],
    ]);
    const ikeX = snapshot.holdings[0];
    if (ikeX === undefined) throw new Error("expected a holding");
    expect(ikeX.lots.map((lot) => lot.quantity)).toEqual([d("6"), d("10")]);
    expect(holdingCostBasis(ikeX)).toEqual(d("1700")); // 6 * 100 + 10 * 110
    expect(holdingAverageCost(ikeX)).toEqual(d("106.25"));
    expect(ikeX.currency).toBe(PLN);
    expect(holdingsOf(snapshot, X)).toHaveLength(2);
    expect(snapshot.cash).toEqual([
      cashBalance({ accountId: IKE, currency: PLN, amount: d("3430") }), // 5000-1000-1100-200+250+480
      cashBalance({ accountId: REGULAR, currency: PLN, amount: d("800") }),
    ]);
    expect(snapshot.deposits.map((dep) => dep.accountId)).toEqual([IKE, REGULAR]);
    expect(snapshot.realized.map((t) => [t.instrumentId, t.pnl])).toEqual([
      [Y, d("50")],
      [X, d("80")],
    ]);
    expect(realizedPnlByCurrency(snapshot)).toEqual(new Map([[PLN, d("130")]]));
    expect(snapshot.warnings).toEqual([]);
  });

  it("account filter and foreign accounts restrict the transactions", () => {
    const txns = [
      buy(IKE, X, "2026-01-05", "10", "100"),
      buy(REGULAR, X, "2026-01-06", "2", "100"),
      buy(FOREIGN, X, "2026-01-06", "7", "100"),
      buy(newId(), X, "2026-01-06", "9", "100"), // account not passed in
    ];

    const allAccounts = buildSnapshot(PROFILE, txns, "2026-03-31", {
      profileAccounts: PROFILE_ACCOUNTS,
    });
    expect(allAccounts.holdings.map((h) => h.accountId)).toEqual([IKE, REGULAR]);

    const onlyRegular = buildSnapshot(PROFILE, txns, "2026-03-31", {
      profileAccounts: PROFILE_ACCOUNTS,
      accountIds: new Set([REGULAR]),
    });
    expect(onlyRegular.holdings.map((h) => h.accountId)).toEqual([REGULAR]);
    expect(onlyRegular.cash.map((c) => c.accountId)).toEqual([REGULAR]);

    // Without profileAccounts every account in the transactions belongs to the profile.
    expect(buildSnapshot(PROFILE, txns, "2026-03-31").holdings).toHaveLength(4);
  });

  it("lot engine warnings are kept and mixed lot currencies flagged", () => {
    const txns = [
      buy(IKE, X, "2026-01-05", "1", "100"),
      buy(IKE, X, "2026-01-06", "1", "25", { currency: USD }),
      sell(REGULAR, Y, "2026-01-07", "3", "10"),
    ];

    const snapshot = buildSnapshot(PROFILE, txns, "2026-03-31", {
      profileAccounts: PROFILE_ACCOUNTS,
    });

    const [gap, mixed, ...cashGaps] = snapshot.warnings;
    expect(gap?.kind).toBe("history_gap");
    expect(gap?.kind === "history_gap" ? gap.shortfall : null).toEqual(d("3"));
    expect(mixed).toEqual(
      mixedLotCurrencies({ accountId: IKE, instrumentId: X, currencies: [PLN, USD] }),
    );
    // Buys without deposits leave negative cash: deposits are missing from the history (R2).
    expect(cashGaps).toEqual([
      cashHistoryGap({ accountId: IKE, currency: PLN, amount: d("-100"), asOf: "2026-03-31" }),
      cashHistoryGap({ accountId: IKE, currency: USD, amount: d("-25"), asOf: "2026-03-31" }),
    ]);
    expect(snapshot.holdings).toHaveLength(1);
    const holding = snapshot.holdings[0];
    if (holding === undefined) throw new Error("expected a holding");
    expect(holding.currency).toBe(PLN);
    expect(holdingCostBasis(holding)).toBeNull(); // never summed across currencies (R12)
    expect(holdingAverageCost(holding)).toBeNull();
  });

  it("restrictSnapshot drops other accounts and keeps global warnings", () => {
    const txns = [
      cashTxn(IKE, "2026-01-02", "100"),
      cashTxn(REGULAR, "2026-01-02", "100"),
      buy(IKE, X, "2026-01-05", "1", "50"),
      buy(REGULAR, X, "2026-01-05", "1", "50"),
      sell(IKE, X, "2026-01-06", "1", "60"),
      sell(REGULAR, Y, "2026-01-07", "3", "10"), // gap in REGULAR
    ];
    const snapshot = buildSnapshot(PROFILE, txns, "2026-03-31", {
      profileAccounts: PROFILE_ACCOUNTS,
    });
    const withGlobalWarning = portfolioSnapshot({
      ...snapshot,
      warnings: [...snapshot.warnings, missingInstrument({ instrumentId: Y })],
    });

    const restricted = restrictSnapshot(withGlobalWarning, new Set([IKE]));

    expect(restricted.holdings).toEqual([]); // x was sold in IKE
    expect(restricted.cash.map((c) => c.accountId)).toEqual([IKE]);
    expect(restricted.deposits.map((dep) => dep.accountId)).toEqual([IKE]);
    expect(restricted.realized.map((t) => t.accountId)).toEqual([IKE]);
    expect(restricted.warnings).toEqual([missingInstrument({ instrumentId: Y })]);
    expect(restrictSnapshot(withGlobalWarning, new Set([REGULAR])).warnings).toHaveLength(2);
    const gaps = snapshot.warnings.filter((w) => w.kind === "history_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.accountId).toBe(REGULAR);
    expect(missingInstrument({ instrumentId: Y }).accountId).toBeNull();
  });

  it("snapshot with a rename carries lots and the last trade price", () => {
    const z = ins(newId());
    const txns = [buy(IKE, X, "2026-01-05", "10", "100"), sell(IKE, z, "2026-03-02", "2", "130")];
    const rename = instrumentRename({
      date: "2026-02-01",
      oldInstrumentId: X,
      newInstrumentId: z,
    });

    const before = buildSnapshot(PROFILE, txns, "2026-01-31", { renames: [rename] });
    expect(before.holdings.map((h) => [h.instrumentId, h.quantity])).toEqual([[X, d("10")]]);

    const after = buildSnapshot(PROFILE, txns, "2026-02-15", { renames: [rename] });
    expect(after.holdings.map((h) => [h.instrumentId, h.quantity])).toEqual([[z, d("10")]]);
    expect(after.lastTradePrices).toEqual(
      new Map([
        [X, datedPrice({ date: "2026-01-05", price: d("100"), currency: PLN })],
        [z, datedPrice({ date: "2026-01-05", price: d("100"), currency: PLN })],
      ]),
    );

    const later = buildSnapshot(PROFILE, txns, "2026-03-31", { renames: [rename] });
    expect(later.holdings.map((h) => [h.instrumentId, h.quantity])).toEqual([[z, d("8")]]);
    expect(later.realized[0]?.pnl).toEqual(d("60"));
    expect(later.lastTradePrices.get(z)?.price).toEqual(d("130"));
    expect(later.warnings.map((w) => w.kind)).toEqual(["cash_history_gap"]); // no deposits in this test
  });
});

// --- last trade prices --------------------------------------------------------------------------

describe("lastTradePrices", () => {
  it("newest positive trade price, split-adjusted once, up to asOf", () => {
    const txns = [
      buy(IKE, X, "2026-01-05", "10", "100"),
      sell(REGULAR, X, "2026-02-02", "1", "120"),
      transferIn(IKE, X, "2026-02-03", "5", { price: "0" }), // no price information
      split(IKE, X, "2026-03-02", "2"),
      split(REGULAR, X, "2026-03-02", "2"), // the same split in the other account
      buy(IKE, Y, "2026-01-05", "1", "30", { currency: USD }),
    ];

    expect(lastTradePrices(txns)).toEqual(
      new Map([
        [X, datedPrice({ date: "2026-02-02", price: d("60"), currency: PLN })],
        [Y, datedPrice({ date: "2026-01-05", price: d("30"), currency: USD })],
      ]),
    );
    expect(lastTradePrices(txns, { asOf: "2026-01-31" }).get(X)?.price).toEqual(d("100"));
    expect(lastTradePrices(txns, { accountIds: new Set([IKE]) }).get(X)?.price).toEqual(d("50")); // 100 / 2
  });

  it("only buy and sell prices count (R13)", () => {
    const txns = [
      buy(IKE, X, "2026-01-05", "10", "100"),
      transferIn(IKE, X, "2026-02-03", "5", { price: "80" }), // transfer value, not a market price
      buildTxn(IKE, X, {
        type: TxnType.ADJUSTMENT,
        tradeDate: "2026-03-01",
        quantity: "2",
        price: "75", // the broker's average cost
        grossAmount: "0",
        cashAmount: "0",
        source: TxnSource.RECONCILIATION,
        createdAt: MARCH_1_UTC,
      }),
      buildTxn(IKE, Y, {
        tradeDate: "2026-03-01",
        quantity: "1",
        price: "9",
        source: TxnSource.RECONCILIATION,
        createdAt: MARCH_1_UTC,
      }),
      transferIn(IKE, Y, "2026-03-02", "1", { price: "12" }),
    ];

    expect(lastTradePrices(txns)).toEqual(
      new Map([[X, datedPrice({ date: "2026-01-05", price: d("100"), currency: PLN })]]),
    );
  });

  it("split booked on different days in two accounts is applied once (R11)", () => {
    const txns = [
      buy(IKE, X, "2026-01-10", "10", "100"),
      buy(REGULAR, X, "2026-01-10", "10", "100"),
      split(IKE, X, "2026-02-02", "2"),
      split(REGULAR, X, "2026-02-03", "2"),
    ];
    expect(lastTradePrices(txns).get(X)).toEqual(
      datedPrice({ date: "2026-01-10", price: d("50"), currency: PLN }),
    );

    // A post-split trade between the two bookings is not halved by the late booking.
    const withTrade = [...txns.slice(0, 3), buy(IKE, X, "2026-02-02", "1", "51"), ...txns.slice(3)];
    expect(lastTradePrices(withTrade).get(X)?.price).toEqual(d("51"));

    // A second split (different ratio, or the same ratio much later) is a new corporate action.
    const twoSplits = [...txns, split(IKE, X, "2026-02-04", "3"), split(IKE, X, "2026-09-01", "2")];
    // 100/2/3/2 rounded per step
    expect(lastTradePrices(twoSplits).get(X)?.price).toEqual(d("8.3333333334"));
  });

  it("snapshot has the last trade prices of its transactions", () => {
    const snapshot = buildSnapshot(
      PROFILE,
      [buy(IKE, X, "2026-01-05", "1", "100"), buy(IKE, X, "2026-04-01", "1", "200")],
      "2026-03-31",
    );
    expect(snapshot.lastTradePrices).toEqual(
      new Map([[X, datedPrice({ date: "2026-01-05", price: d("100"), currency: PLN })]]),
    );
  });
});
