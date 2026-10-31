import { D, Money } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue, PortCodecError, toJson } from "./codec.js";

describe("store port codec", () => {
  it("rebuilds decimals and money exactly after a structured clone", () => {
    const value = {
      rows: [{ amount: D("-0.00"), money: new Money(D("1E+1"), "PLN"), n: 3n }],
      none: null,
    };
    const back = decodeValue(structuredClone(encodeValue(value))) as typeof value;
    const row = back.rows[0];
    expect(row?.amount.toString()).toBe("-0.00");
    expect(row?.money).toBeInstanceOf(Money);
    expect(row?.money.amount.toString()).toBe("1E+1");
    expect(row?.money.currency).toBe("PLN");
    expect(row?.n).toBe(3n);
  });

  it("refuses values that would lose their meaning on the way", () => {
    expect(() => encodeValue(new (class Row {})())).toThrow(PortCodecError);
    expect(() => encodeValue({ "~cashu": "decimal" })).toThrow(PortCodecError);
    expect(() => encodeValue(() => 1)).toThrow(PortCodecError);
    expect(() => decodeValue({ "~cashu": "nope" })).toThrow(PortCodecError);
  });

  it("sends command input as JSON", () => {
    expect(toJson({ a: 1, b: undefined, c: [undefined, "x"] })).toEqual({ a: 1, c: [null, "x"] });
    expect(() => toJson({ d: D("1") })).toThrow(PortCodecError);
    expect(() => toJson(Number.NaN)).toThrow(PortCodecError);
  });
});
