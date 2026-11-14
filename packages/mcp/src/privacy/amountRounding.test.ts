// Money rounding on the label layer: FX-converted amounts are rounded so they pass the leak check in
// both modes, while an unrounded FX float would be withheld.
import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { pyDumps } from "./pyJson.js";
import { LeakDetected, leakCheck, Redactor } from "./redactor.js";

it("test_label_helpers_round", () => {
  expect(L.amount(0.1 + 0.2).value).toBe(0.3);
  expect(L.amount(D("110034.5950716749")).value).toBe(110034.6);
  expect(L.amount(D("0.33333333333"), 8).value).toBe(0.33333333);
  expect(L.amount(1250n).value).toBe(1250n); // an int stays an int
  expect(L.amount(null).value).toBeNull();
  expect(L.level(D("187.123456789012")).value).toBe(187.12345679);
  expect(L.level(null).value).toBeNull();
});

describe("test_fx_converted_values_pass_the_leak_check (label layer; tool flow: S38)", () => {
  // a fractional unit count bought at an FX rate with many digits
  const quantity = 0.3333333 + 31;
  const value = 110034.5950716749;
  const tree = {
    total: L.amount(value * 3.98765432),
    positions: [{ value: L.amount(value), quantity: L.amount(quantity, 8), weight: L.pct(0.153) }],
  };
  for (const privacy of ["strict", "amounts"] as const) {
    it(privacy, () => {
      const out = new Redactor({ privacy }).apply(tree);
      leakCheck(out, { strict: privacy === "strict" });
      expect(pyDumps(out)).not.toMatch(/\d{10,}/);
    });
  }
  it("an unrounded FX float would be withheld by the leak check", () => {
    expect(() => leakCheck({ total: value * 3.98765432 }, { strict: false })).toThrow(LeakDetected);
  });
});

it("test_amounts_mode_sends_rounded_money (label layer)", () => {
  const out = new Redactor({ privacy: "amounts" }).apply({
    total: L.amount(438776.12345),
    quantity: L.amount(31.3333333, 8),
  }) as { total: number; quantity: number };
  expect(out.total).toBe(438776.12);
  expect(out.quantity).toBeCloseTo(31.3333333, 8); // unit counts keep 8 places, they are not money
});
