/** Stored alert signal facts become a stable message code and params for the UI to translate. */
import { expect, it } from "vitest";
import { alertMessage } from "./messages.js";

it("only alert signals map; known facts are copied, price_date becomes date, the label falls back to the symbol", () => {
  expect(alertMessage("allocation_drift", { title: "x" }, "m")).toEqual([null, null]);
  expect(
    alertMessage(
      "alert:price_above",
      {
        title: "VWCE above 120",
        symbol: "VWCE",
        close: "121.5",
        level: "120",
        currency: "EUR",
        price_date: "2026-10-02",
        alert_id: "a1",
      },
      "VWCE above 120: ...",
    ),
  ).toEqual([
    "alert.price_above",
    {
      title: "VWCE above 120",
      label: "VWCE",
      close: "121.5",
      level: "120",
      currency: "EUR",
      date: "2026-10-02",
    },
  ]);
  expect(alertMessage("alert:new_high", { symbol: "VWCE" }, "m", "Vanguard")[1]?.label).toBe(
    "Vanguard",
  );
});

it("change_pct splits the signed change into a direction and a size; weights name their subject", () => {
  expect(alertMessage("alert:change_pct", { change: -0.12 }, "m")[1]).toMatchObject({
    direction: "down",
    change: 0.12,
  });
  expect(alertMessage("alert:change_pct", { change: 0.05 }, "m")[1]).toMatchObject({
    direction: "up",
    change: 0.05,
  });
  expect(alertMessage("alert:weight_above", { bucket_id: "equity" }, "m")[1]?.subject).toBe(
    "bucket",
  );
  expect(alertMessage("alert:weight_below", { bucket_id: null }, "m")[1]?.subject).toBe(
    "instrument",
  );
});

it("custom and unknown kinds keep the stored text, stripping only an exact title prefix", () => {
  expect(alertMessage("alert:custom", { title: "A", symbol: "" }, "A: detail")).toEqual([
    "alert.custom",
    { title: "A", label: "", detail: "detail" },
  ]);
  expect(alertMessage("alert:custom", { title: "A" }, "Other: detail")[1]?.detail).toBe(
    "Other: detail",
  );
  expect(alertMessage("alert:retired_kind", null, "kept as is")).toEqual([
    "alert.retired_kind",
    { title: null, label: null, detail: "kept as is" },
  ]);
});
