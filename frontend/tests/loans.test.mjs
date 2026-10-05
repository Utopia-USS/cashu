// Loans widget helpers (F7 FE9 / FE10) and the Przegląd monthly norm over complete months. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { incomeShare, rateText } from "../src/modules/loans/logic.ts";
import { closedMonthNorm } from "../src/core/util.ts";

test("FE9: the rate is a percent from the API, also below 1 %", () => {
  assert.equal(rateText(0.85), "0,85 %");
  assert.equal(rateText(7.25), "7,25 %");
  assert.equal(rateText(0), "0 %");
  assert.equal(rateText(null), null);
});

test("FE10: ratios divide by the average of complete months, never the running one", () => {
  const rows = [
    { label: "2026-07", income: 9000, expense: 8000, net: 1000 },
    { label: "2026-08", income: 9000, expense: 8800, net: 200 },
    { label: "2026-09", income: 9300, expense: 9000, net: 300 },
    { label: "2026-10", income: 0, expense: 1250, net: -1250 },
  ];
  const n = closedMonthNorm(rows, "2026-10-05");
  assert.equal(n.months, 3);
  assert.equal(n.income, 9100);
  assert.ok(Math.abs(n.expense - 8600) < 1e-9);
  assert.equal(closedMonthNorm([{ label: "2026-10", income: 100, expense: 50 }], "2026-10-05"), null);
  assert.equal(closedMonthNorm(null, "2026-10-05"), null);
  assert.equal(closedMonthNorm(rows, "2026-10-05", 1).expense, 9000);
  // liquid 52 000 / 8 600 = 6,0 months (not 41,6 with October's 1 250)
  assert.equal(Math.round((52000 / n.expense) * 10) / 10, 6);
  assert.equal(incomeShare(2900, n.income), 2900 / 9100);
  assert.equal(incomeShare(2900, null), null);
});
