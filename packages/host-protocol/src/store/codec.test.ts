import { D, Money } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue, type JsonValue, StoreCodecError, toJson } from "./codec.js";

/** Through the wire: encode, JSON text, parse, decode. */
const wire = (value: unknown) =>
  decodeValue(JSON.parse(JSON.stringify(encodeValue(value))) as JsonValue);

describe("store channel v2 codec", () => {
  it("keeps every value structured clone kept, exactly", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255, 7]);
    const value = {
      rows: [
        {
          amount: D("-0.00"),
          money: new Money(D("1E+1"), "PLN"),
          n: 3n,
          big: -12345678901234567890n,
          at: new Date(Date.UTC(2026, 10, 1, 8, 30)),
          bad: new Date(Number.NaN),
          bytes,
        },
      ],
      specials: [-0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1.5],
      holes: [undefined, null, "x"],
      none: null,
      flag: false,
    };
    const back = wire(value) as typeof value;
    const row = back.rows[0];
    expect(row?.amount.toString()).toBe("-0.00");
    expect(row?.money).toBeInstanceOf(Money);
    expect(row?.money.amount.toString()).toBe("1E+1");
    expect(row?.money.currency).toBe("PLN");
    expect(row?.n).toBe(3n);
    expect(row?.big).toBe(-12345678901234567890n);
    expect(row?.at.toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(Number.isNaN(row?.bad.getTime())).toBe(true);
    expect(row?.bytes).toEqual(bytes);
    expect(Object.is(back.specials[0], -0)).toBe(true);
    expect(back.specials.slice(1)).toEqual([Number.NaN, Infinity, -Infinity, 0, 1.5]);
    expect(back.holes).toEqual([undefined, null, "x"]);
    expect(back.none).toBeNull();
    expect(back.flag).toBe(false);
    expect(wire(undefined)).toBeUndefined();
  });

  it("round-trips bytes of every length mod 3, and Buffers arrive as Uint8Array", () => {
    for (let n = 0; n < 8; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97) % 256);
      expect(wire(b)).toEqual(b);
    }
    expect(encodeValue(Buffer.from("hi"))).toEqual({ "~cashu": "bytes", v: "aGk=" });
  });

  it("drops undefined object fields", () => {
    expect(encodeValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("refuses values that would lose their meaning on the way", () => {
    expect(() => encodeValue(new (class Row {})())).toThrow(StoreCodecError);
    expect(() => encodeValue(new Map())).toThrow(StoreCodecError);
    expect(() => encodeValue(new Uint16Array(2))).toThrow(StoreCodecError);
    expect(() => encodeValue({ "~cashu": "decimal" })).toThrow(StoreCodecError);
    expect(() => encodeValue(() => 1)).toThrow(StoreCodecError);
    expect(() => encodeValue(Symbol("x"))).toThrow(StoreCodecError);
    const bads: JsonValue[] = [
      { "~cashu": "nope" },
      { "~cashu": "decimal" },
      { "~cashu": "bigint", v: "1.5" },
      { "~cashu": "number", v: "7" },
      { "~cashu": "bytes", v: "abc" },
      { "~cashu": "bytes", v: "a=bc" },
      { "~cashu": "date", v: "2026" },
    ];
    for (const bad of bads) {
      expect(() => decodeValue(bad), JSON.stringify(bad)).toThrow(StoreCodecError);
    }
  });

  it("sends command input as JSON", () => {
    expect(toJson({ a: 1, b: undefined, c: [undefined, "x"] })).toEqual({ a: 1, c: [null, "x"] });
    expect(() => toJson({ d: D("1") })).toThrow(StoreCodecError);
    expect(() => toJson(Number.NaN)).toThrow(StoreCodecError);
  });
});
