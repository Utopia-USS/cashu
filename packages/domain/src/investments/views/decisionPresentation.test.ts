import { expect, it } from "vitest";
import { D } from "../../decimal.js";
import { decisionEstimate, decisionSuggestion } from "./decisionPresentation.js";

const position = { quantity: D("4.5"), price: D("10"), priceCurrency: "PLN" };
it("matches positive SPA ceil/round suggestions, zero excess and the foreign quote safety boundary", () => {
  const input = {
    signal: { kind: "position_concentration", payload: { weight: 0.3, max_weight: 0.2 } },
    position,
    total: D("1000"),
    base: "PLN",
  };
  expect(decisionSuggestion(input).quantity?.toString()).toBe("10");
  expect(
    decisionSuggestion({
      ...input,
      signal: { ...input.signal, payload: { weight: 0.2, max_weight: 0.2 } },
    }).quantity,
  ).toBeNull();
  expect(
    decisionSuggestion({ ...input, position: { ...position, priceCurrency: "USD" } }),
  ).toMatchObject({ quantity: null, quantityUnavailable: "currency_mismatch", currency: "USD" });
  expect(
    decisionSuggestion({
      ...input,
      signal: { kind: "price_below", payload: {} },
    }).quantity?.toString(),
  ).toBe("2");
  expect(
    decisionSuggestion({
      ...input,
      signal: { kind: "price_below", payload: {} },
      position: { ...position, quantity: D("0.1") },
    }).quantity?.toString(),
  ).toBe("1");
});
it("keeps exact amount and source same-currency generic allocation estimates", () => {
  const input = {
    side: "buy" as const,
    quantity: D("2.5"),
    price: D("10.01"),
    currency: "PLN",
    base: "PLN",
    total: D("1000"),
    bucket: { value: D("200"), target: 0.2, driftPp: 0, generic: true },
  };
  const result = decisionEstimate(input);
  expect(result?.amount.toString()).toBe("25.025");
  expect(result?.allocation).toMatchObject({ afterWeight: 0.225025, driftPp: 2.5025, grows: true });
  expect(decisionEstimate({ ...input, currency: "USD" })?.allocation).toBeNull();
  expect(
    decisionEstimate({ ...input, bucket: { ...input.bucket, generic: false } })?.allocation,
  ).toBeNull();
  expect(decisionEstimate({ ...input, quantity: D("0") })).toBeNull();
});

it("checks defaults against the actual Signals.tsx initializer and records its foreign-currency defect", () => {
  // Expectations captured from the retired oracle (defaultAct and the quantity initializer of
  // frontend/src/modules/investments/v2/Signals.tsx) on 2026-11-04: [signal, quantity, price, choice, quantity text].
  const signal = { kind: "position_concentration", payload: { weight: 0.3, max_weight: 0.2 } };
  for (const [current, quantity, price, choice, expected] of [
    [signal, 4.5, 10, "sell", "10"],
    [{ ...signal, payload: { weight: 0.2, max_weight: 0.2 } }, 4.5, 10, "sell", ""],
    [{ kind: "price_below", payload: {} }, 4.5, 10, "buy", "2"],
  ] as const) {
    const result = decisionSuggestion({
      signal: current,
      position: { quantity: D(String(quantity)), price: D(String(price)), priceCurrency: "PLN" },
      total: D("1000"),
      base: "PLN",
    });
    expect(result.choice).toBe(choice);
    expect(result.quantity?.toString() ?? "").toBe(expected);
  }
  // Source had no currency check and suggested "10" USD shares from a PLN excess for the first signal
  // above. Native leaves it editable.
  expect(
    decisionSuggestion({
      signal,
      position: { quantity: D("4.5"), price: D("10"), priceCurrency: "USD" },
      total: D("1000"),
      base: "PLN",
    }).quantityUnavailable,
  ).toBe("currency_mismatch");
});
