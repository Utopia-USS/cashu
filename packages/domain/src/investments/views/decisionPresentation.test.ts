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

// The actual SPA expressions are the oracle for defaults; no copy of their algorithm in the test.
it("checks defaults against the actual Signals.tsx initializer and records its foreign-currency defect", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../../../../frontend/src/modules/investments/v2/Signals.tsx", import.meta.url),
    "utf8",
  );
  const actStart = source.indexOf("function defaultAct(");
  const actBody = source.slice(
    source.indexOf("{", actStart) + 1,
    source.indexOf("\n}\n", actStart),
  );
  const defaultAct = new Function("s", actBody) as (
    signal: { kind: string; payload: Record<string, unknown> } | null,
  ) => string;
  const quantityStart = source.indexOf('    if (!pos || !pos.price || !s) return "";');
  const quantityBody = source.slice(quantityStart, source.indexOf("\n  });", quantityStart));
  const original = new Function("s", "pos", "ctx", "defaultAct", quantityBody) as (
    signal: { kind: string; payload: Record<string, unknown> },
    position: { quantity: number; price: number },
    context: { total: number },
    act: typeof defaultAct,
  ) => string;
  const signal = { kind: "position_concentration", payload: { weight: 0.3, max_weight: 0.2 } };
  for (const [current, quantity, price] of [
    [signal, 4.5, 10],
    [{ ...signal, payload: { weight: 0.2, max_weight: 0.2 } }, 4.5, 10],
    [{ kind: "price_below", payload: {} }, 4.5, 10],
  ] as const) {
    const expected = original(current, { quantity, price }, { total: 1000 }, defaultAct);
    const result = decisionSuggestion({
      signal: current,
      position: { quantity: D(String(quantity)), price: D(String(price)), priceCurrency: "PLN" },
      total: D("1000"),
      base: "PLN",
    });
    expect(result.choice).toBe(defaultAct(current));
    expect(result.quantity?.toString() ?? "").toBe(expected);
  }
  // Source has no currency check and suggests 10 USD shares from a PLN excess. Native leaves it editable.
  expect(original(signal, { quantity: 4.5, price: 10 }, { total: 1000 }, defaultAct)).toBe("10");
  expect(
    decisionSuggestion({
      signal,
      position: { quantity: D("4.5"), price: D("10"), priceCurrency: "USD" },
      total: D("1000"),
      base: "PLN",
    }).quantityUnavailable,
  ).toBe("currency_mismatch");
});
