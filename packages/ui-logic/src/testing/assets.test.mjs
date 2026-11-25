// Manual asset helpers (src/modules/assets/logic.ts). Runs with the ui-logic Vitest suite.
import assert from "node:assert/strict";
import { monthlyLoss, ratePct, valuationLabel } from "@cashu/ui-logic/assets/logic";
import { test } from "vitest";

// ---- the Majątek widget on Przegląd (F7 merge) ------------------------------------------------------------

test("monthly loss of a vehicle: declining balance at the yearly rate (a fraction, contract), the floor stops it", () => {
  const dep = {
    purchase_price: 89000,
    purchase_date: "2023-04-14",
    annual_rate: 0.15,
    floor: null,
  };
  assert.ok(Math.abs(monthlyLoss(52600, dep) - 707.6) < 0.1);
  assert.equal(monthlyLoss(8000, { ...dep, floor: 8000 }), 0);
  assert.equal(monthlyLoss(7000, { ...dep, floor: 8000 }), 0);
  // just above the floor: never past it within the month
  assert.equal(monthlyLoss(8100, { ...dep, floor: 8000 }), 100);
  assert.equal(monthlyLoss(52600, null), null);
  assert.equal(monthlyLoss(52600, undefined), null);
  assert.equal(monthlyLoss(null, dep), null);
  assert.equal(ratePct(0.15), "15");
  assert.equal(ratePct(0.125), "12,5");
});

test("valuation line: day.month this year, the year otherwise; older than 365 days is stale", () => {
  assert.deepEqual(valuationLabel("2026-09-01", "2026-10-05"), {
    text: "wycena 1.09",
    stale: false,
  });
  assert.deepEqual(valuationLabel("2025-03-03", "2026-10-05"), {
    text: "wycena 3.03.2025",
    stale: true,
  });
  assert.equal(valuationLabel("2025-10-05", "2026-10-05").stale, false); // exactly 365 days
  assert.equal(valuationLabel("2025-10-04", "2026-10-05").stale, true); // 366
  assert.equal(valuationLabel(null, "2026-10-05"), null);
  assert.equal(valuationLabel("", "2026-10-05"), null);
});

// ---- first steps: vehicles and the steps (design/v3/first-steps sections 10, 11) ------------------------------
import { assetSteps, curvePreview, vehicleValue } from "@cashu/ui-logic/assets/logic";

test("first steps: a vehicle's value follows the declining-balance curve (depreciation.py)", () => {
  // 523 days at 15 % a year: 80 000 * 0.85 ** (523 / 365.25)
  assert.ok(Math.abs(vehicleValue(80000, "2025-05-01", 15, null, "2026-10-06") - 63391) < 1);
  assert.equal(vehicleValue(80000, "2025-05-01", 15, 70000, "2026-10-06"), 70000);
  assert.equal(vehicleValue(80000, "2026-11-01", 15, null, "2026-10-06"), 0);
  const p = curvePreview(
    { price: "80 000", purchaseDate: "2025-05-01", ratePct: "15", floor: "" },
    "2026-10-06",
  );
  assert.equal(Math.round(p.loss), 853);
  const atFloor = curvePreview(
    { price: "80000", purchaseDate: "2025-05-01", ratePct: "15", floor: "70000" },
    "2026-10-06",
  );
  assert.equal(atFloor.value, 70000);
  assert.equal(atFloor.loss, 0);
});

test("first steps: the assets steps come from the rows", () => {
  assert.deepEqual(assetSteps([]), { position: "on", vehicle: "todo" });
  assert.deepEqual(assetSteps([{ kind: "manual", type: "property" }]), {
    position: "done",
    vehicle: "todo",
  });
  assert.deepEqual(
    assetSteps([
      {
        kind: "vehicle",
        type: "vehicle",
        depreciation: {
          purchase_price: 1,
          purchase_date: "2025-01-01",
          annual_rate: 0.1,
          floor: null,
        },
      },
    ]),
    { position: "done", vehicle: "done" },
  );
  // a car without a curve is not the step done
  assert.deepEqual(assetSteps([{ kind: "vehicle", type: "vehicle", depreciation: null }]), {
    position: "done",
    vehicle: "todo",
  });
});
