/**
 * Review finding R2 through the real pipeline `buildSnapshot` -> `valuePortfolio` -> `allocate`: a
 * negative cash balance (deposits missing from the history) counts as zero in the total, so holding
 * weights stay real, and the cash bucket is flagged. The other review fixes (R1, R4-R15) are pinned at
 * their own layer: allocation, valuation, snapshotBuilder, lotEngine and the importing tests.
 * Synthetic data only.
 */
import { expect, it } from "vitest";
import { type Decimal, decimalKey } from "../../decimal.js";
import {
  AssetClass,
  allocationOf,
  allocationPlan,
  asAccountId,
  asProfileId,
  bucketDef,
  bucketMatch,
  cashHistoryGap,
  priceBar,
  TxnType,
  warningKey,
} from "../domain/index.js";
import { allocate, buildSnapshot, InMemoryFxLookup, valuePortfolio } from "./index.js";
import { buildTxn, d, instrument, marketView, newId, PLN } from "./testing/fixtures.js";

const ACCOUNT = newId();
const AS_OF = "2026-10-01";

function expectD(actual: Decimal | null | undefined, expected: string): void {
  expect(actual == null ? null : decimalKey(actual)).toBe(decimalKey(d(expected)));
}

it("r2 negative cash counts as zero and weights are real", () => {
  const aaa = instrument(null, { name: "AAA SA", symbol: "AAA" });
  const bbb = instrument(null, { name: "BBB SA", symbol: "BBB" });
  const plan = allocationPlan({
    buckets: [
      bucketDef({ id: "stocks", match: bucketMatch({ assetClasses: [AssetClass.EQUITY] }) }),
      bucketDef({ id: "cash", match: bucketMatch({ assetClasses: [AssetClass.CASH] }) }),
    ],
    targets: { stocks: 0.95, cash: 0.05 },
  });
  const txns = [
    buildTxn(ACCOUNT, null, {
      type: TxnType.DEPOSIT,
      tradeDate: "2026-09-01",
      quantity: null,
      price: null,
      grossAmount: "70000",
      cashAmount: "70000",
    }),
    buildTxn(ACCOUNT, aaa.id, { tradeDate: "2026-09-02", quantity: "100", price: "600" }),
    buildTxn(ACCOUNT, bbb.id, { tradeDate: "2026-09-03", quantity: "100", price: "400" }),
  ];
  const snapshot = buildSnapshot(asProfileId(newId()), txns, AS_OF);
  const bars = [
    priceBar({ instrumentId: aaa.id, date: AS_OF, close: d("600"), source: "test" }),
    priceBar({ instrumentId: bbb.id, date: AS_OF, close: d("400"), source: "test" }),
  ];
  const valued = valuePortfolio(
    snapshot,
    marketView(AS_OF, { instruments: [aaa, bbb], bars }),
    new InMemoryFxLookup([]),
    PLN,
    5,
  );
  const allocation = allocate(valued, plan);

  expect(snapshot.warnings.map(warningKey)).toEqual(
    [
      cashHistoryGap({
        accountId: asAccountId(ACCOUNT),
        currency: PLN,
        amount: d("-30000"),
        asOf: AS_OF,
      }),
    ].map(warningKey),
  );
  expectD(valued.cash[0]?.amountBase, "-30000");
  expectD(valued.cashBase, "0");
  expectD(valued.totalBase, "100000");
  const weight = (symbol: string) =>
    valued.valued.find((v) => v.instrument.symbol === symbol)?.weight;
  expect(weight("AAA")).toBe(0.6); // a real 60 % position
  expect(weight("BBB")).toBe(0.4); // not the old 57 %
  expect(allocationOf(allocation, "cash")?.cashHistoryGap).toBe(true);
  expect(allocationOf(allocation, "stocks")?.cashHistoryGap).toBe(false);
});
