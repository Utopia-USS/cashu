import { expect, it } from "vitest";
import { addMicroseconds, parseDateTime } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  Currencies,
  type Currency,
  holding,
  type PortfolioSnapshot,
  portfolioSnapshot,
  TxnSource,
  TxnType,
} from "../domain/index.js";
import { parsedPosition } from "./contract.js";
import {
  type BrokerPosition,
  brokerPosition,
  brokerPositionFromParsed,
  PositionDiffKind,
  positionDelta,
  type ReconcileOptions,
  reconcile,
  reportIsClean,
  reportMismatches,
} from "./reconciler.js";
import { counterIds, d, day } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_reconciler.py (reconciliation of broker
// positions with a portfolio snapshot; port of reconciler_test). Python's `txn_id_factory` is
// optional (random UUIDs); in TS it is required, so tests that do not look at ids pass a counter.

// Python `Decimal ==` compares by value (`Decimal("100") == Decimal("100.00")`).
expect.addEqualityTesters([
  (a: unknown, b: unknown) => (a instanceof Decimal && b instanceof Decimal ? a.eq(b) : undefined),
]);

const ACCOUNT = asAccountId("acc-1");
const OTHER = asAccountId("acc-2");
const NOW = parseDateTime("2026-02-01T09:00:00+00:00");
const { PLN, EUR, USD } = Currencies;

const ids = (prefix = "rec"): ReconcileOptions => {
  const next = counterIds(prefix);
  return { txnIdFactory: () => asTxnId(next()) };
};

function position(
  instrumentId: string,
  quantity: string,
  options: { avgPrice?: string; asOf?: string; currency?: Currency } = {},
): BrokerPosition {
  return brokerPosition({
    instrumentId: asInstrumentId(instrumentId),
    quantity: d(quantity),
    currency: options.currency ?? PLN,
    asOf: day(options.asOf ?? "2026-01-31"),
    avgPrice: options.avgPrice === undefined ? null : d(options.avgPrice),
  });
}

function snapshot(asOf = "2026-01-31"): PortfolioSnapshot {
  const held = (account: typeof ACCOUNT, instrumentId: string, quantity: string) =>
    holding({
      accountId: account,
      instrumentId: asInstrumentId(instrumentId),
      currency: PLN,
      quantity: d(quantity),
    });
  return portfolioSnapshot({
    profileId: asProfileId("p"),
    asOf: day(asOf),
    holdings: [
      held(ACCOUNT, "a", "10"),
      held(ACCOUNT, "b", "5"),
      held(ACCOUNT, "c", "3"),
      held(OTHER, "a", "7"),
    ],
  });
}

const correctionAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no correction ${index}`);
  return item;
};

it("diff per instrument and proposed corrections", () => {
  const report = reconcile(
    ACCOUNT,
    [position("a", "10"), position("b", "8", { avgPrice: "20" }), position("missing", "4")],
    snapshot(),
    { now: NOW, ...ids() },
  );
  expect(report.accountId).toBe(ACCOUNT);
  expect(report.asOf).toBe(day("2026-01-31"));
  expect(report.warnings).toEqual([]);
  expect(reportIsClean(report)).toBe(false);
  expect(report.diffs.map((x) => [x.instrumentId, x.kind, positionDelta(x)])).toEqual([
    ["a", PositionDiffKind.MATCH, d("0")],
    ["b", PositionDiffKind.MISMATCH, d("3")],
    ["missing", PositionDiffKind.MISSING_IN_HISTORY, d("4")],
    ["c", PositionDiffKind.MISSING_AT_BROKER, d("-3")],
  ]);
  expect(reportMismatches(report).map((x) => x.instrumentId)).toEqual(["b", "missing", "c"]);

  expect(report.corrections).toHaveLength(3);
  const more = correctionAt(report.corrections, 0);
  const unknownCost = correctionAt(report.corrections, 1);
  const surplus = correctionAt(report.corrections, 2);
  expect(more.diff.instrumentId).toBe("b");
  expect([more.txn.type, more.txn.quantity, more.txn.price]).toEqual([
    TxnType.ADJUSTMENT,
    d("3"),
    d("20"),
  ]);
  expect(more.txn.grossAmount).toEqual(d("60"));
  expect(more.txn.note).toBe(
    "Reconciliation: broker reports 8, history gives 5 (+3); cost = broker average price 20",
  );
  expect([unknownCost.txn.type, unknownCost.txn.quantity]).toEqual([TxnType.ADJUSTMENT, d("4")]);
  // unknown cost, flagged by the lot engine
  expect(unknownCost.txn.price).toBeNull();
  expect(unknownCost.txn.grossAmount).toEqual(d("0"));
  expect(unknownCost.txn.note?.endsWith("cost unknown")).toBe(true);
  // quantities are never negative
  expect(surplus.txn.type).toBe(TxnType.TRANSFER_OUT);
  expect([surplus.txn.quantity, surplus.txn.price]).toEqual([d("3"), null]);
  expect(surplus.txn.note).toBe("Reconciliation: broker reports 0, history gives 3 (-3)");

  for (const correction of report.corrections) {
    const txn = correction.txn;
    expect(txn.source).toBe(TxnSource.RECONCILIATION);
    expect(txn.accountId).toBe(ACCOUNT);
    expect(txn.tradeDate).toBe(day("2026-01-31"));
    expect(txn.cashAmount).toEqual(d("0"));
    expect(txn.importBatchId).toBeNull();
  }
  expect(report.corrections.map((c) => c.txn.id)).toEqual(["rec-1", "rec-2", "rec-3"]);
  expect(new Set(report.corrections.map((c) => c.txn.dedupHash)).size).toBe(3);
  expect(report.corrections.map((c) => c.txn.createdAt)).toEqual([
    NOW,
    addMicroseconds(NOW, 1000),
    addMicroseconds(NOW, 2000),
  ]);
});

it("same proposal gets the same dedup hash", () => {
  const run = (prefix: string) =>
    reconcile(
      ACCOUNT,
      [position("a", "11"), position("b", "5"), position("c", "3")],
      snapshot(),
      ids(prefix),
    );
  expect(correctionAt(run("x").corrections, 0).txn.dedupHash).toBe(
    correctionAt(run("y").corrections, 0).txn.dedupHash,
  );
});

it("fully matching account is clean and tolerance absorbs rounding", () => {
  const positions = [position("a", "10.00004"), position("b", "5"), position("c", "3")];
  expect(
    reportIsClean(reconcile(ACCOUNT, positions, snapshot(), { tolerance: d("0.0001"), ...ids() })),
  ).toBe(true);
  const exact = reconcile(ACCOUNT, positions, snapshot(), ids());
  expect(reportMismatches(exact).map((x) => x.instrumentId)).toEqual(["a"]);
  expect(correctionAt(exact.corrections, 0).txn.quantity).toEqual(d("0.00004"));
});

it("several rows of one instrument are summed with a weighted average price", () => {
  const report = reconcile(
    ACCOUNT,
    [
      position("a", "10"),
      position("b", "4", { avgPrice: "10" }),
      position("b", "4", { avgPrice: "20" }),
      position("c", "3"),
    ],
    snapshot(),
    ids(),
  );
  expect(report.corrections).toHaveLength(1);
  const correction = correctionAt(report.corrections, 0);
  expect(correction.diff.brokerQuantity).toEqual(d("8"));
  expect(correction.txn.quantity).toEqual(d("3"));
  expect(correction.txn.price).toEqual(d("15"));
});

it("warns about date and currency mismatches", () => {
  const report = reconcile(
    ACCOUNT,
    [
      position("a", "10", { asOf: "2026-01-30" }),
      position("b", "5", { currency: EUR }),
      position("c", "3"),
    ],
    snapshot("2026-01-29"),
    ids(),
  );
  expect(report.asOf).toBe(day("2026-01-31"));
  expect(report.warnings).toEqual([
    "Broker positions have 2 different dates; used 2026-01-31",
    "Snapshot is as of 2026-01-29 but broker positions as of 2026-01-31",
    "Currency of b differs: history PLN, broker EUR",
  ]);
});

it("no positions: every holding is missing at the broker", () => {
  const report = reconcile(ACCOUNT, [], snapshot(), ids());
  expect(report.asOf).toBe(day("2026-01-31"));
  expect(new Set(report.diffs.map((x) => x.kind))).toEqual(
    new Set([PositionDiffKind.MISSING_AT_BROKER]),
  );
  expect(new Set(report.corrections.map((c) => c.txn.type))).toEqual(
    new Set([TxnType.TRANSFER_OUT]),
  );
  // holdings of other accounts are ignored
  expect(report.diffs).toHaveLength(3);
});

it("broker position from parsed", () => {
  const parsed = parsedPosition({
    quantity: d("2"),
    currency: USD,
    asOf: day("2026-01-31"),
    avgPrice: d("5"),
    symbol: "X",
  });
  const resolved = brokerPositionFromParsed(parsed, asInstrumentId("inst"));
  expect([resolved.instrumentId, resolved.quantity, resolved.avgPrice]).toEqual([
    "inst",
    d("2"),
    d("5"),
  ]);
});
