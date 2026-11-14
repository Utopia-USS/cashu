import { expect, it } from "vitest";
import { D } from "../../decimal.js";
import { assetFeeSummary, assetLotFacts, assetQuoteFacts } from "./assetPresentation.js";
import type { PositionChartView } from "./positionChart.js";
import type { PositionDetailView } from "./positionDetail.js";
import type { PositionRow } from "./positions.js";

function chart(values: readonly string[]): PositionChartView {
  return {
    series: values.map((value, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      close: D(value),
    })),
    last: null,
    high_52w: D("20"),
  } as PositionChartView;
}

it("uses the actual source displayed-range log-return sample, including 9/10-close boundary", () => {
  // Expectations captured from the retired oracle (the vol30 expression of
  // frontend/src/modules/investments/v2/AssetPage.tsx) on 2026-11-04.
  for (const [values, expected] of [
    [Array(9).fill("10"), null],
    [Array(10).fill("10"), 0],
    [Array.from({ length: 31 }, (_, i) => String(10 + (i % 3) - i / 10)), 0.15491699473811396],
  ] as const) {
    const result = assetQuoteFacts(chart(values), D("15"));
    if (expected === null) expect(result.volatility30).toBeNull();
    else expect(result.volatility30).toBeCloseTo(expected, 12);
  }
  expect(assetQuoteFacts(chart(["0", ...Array(10).fill("10")]), D("15")).volatility30).toBeNull();
  expect(assetQuoteFacts(chart(["10"]), D("15")).rangeLow).toBeNull();
});

it("keeps stable lot order, exact cost fraction and multi-account identity", () => {
  const lots = [
    {
      account_id: "b",
      open_date: "2026-10-02",
      quantity: D("0.1"),
      unit_cost: D("0.2"),
      result: D("0.01"),
    },
    { account_id: "a", open_date: "2026-10-01", quantity: D("1"), unit_cost: null, result: null },
    {
      account_id: "b",
      open_date: "2026-10-02",
      quantity: D("1"),
      unit_cost: D("0"),
      result: D("1"),
    },
  ] as PositionRow["lots"];
  const result = assetLotFacts(lots);
  expect(result.rows.map((row) => row.account_id)).toEqual(["a", "b", "b"]);
  expect(result.rows.map((row) => row.resultPct)).toEqual([null, 0.5, null]);
  expect(result.multiAccount).toBe(true);
});

it("corrects the narrow legacy mixed-unit fee header by retaining each original currency", () => {
  const rows = [
    { currency: "USD", fee: D("0.1") },
    { currency: "PLN", fee: D("0.2") },
    { currency: "USD", fee: D("0.2") },
  ] as unknown as PositionDetailView["transactions"];
  expect(assetFeeSummary(rows).map((row) => [row.currency, row.amount.toString()])).toEqual([
    ["PLN", "0.2"],
    ["USD", "0.3"],
  ]);
});
