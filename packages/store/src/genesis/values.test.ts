// S26 spec 2.3 value decoding: timestamp forms, exponent decimals, NAME enums, strict JSON.
import { describe, expect, it } from "vitest";
import { DECIMAL_RE, TIMESTAMP_RE } from "../events/v1/primitives.js";
import {
  decodeBool,
  decodeDate,
  decodeDecimal,
  decodeInt,
  decodeJson,
  decodeSource,
  decodeText,
  decodeTimestamp,
} from "./values.js";

const value = <T>(r: { ok: true; value: T } | { ok: false; reason: string }) =>
  r.ok ? r.value : `FAIL:${r.reason}`;

describe("decodeTimestamp", () => {
  it.each([
    ["2026-01-02 03:04:05.123456", "2026-01-02T03:04:05.123456Z"],
    ["2026-01-02T03:04:05.123456", "2026-01-02T03:04:05.123456Z"],
    ["2026-01-02 03:04:05", "2026-01-02T03:04:05Z"],
    ["2026-01-02 03:04:05.5", "2026-01-02T03:04:05.5Z"],
    ["2026-01-02 03:04:05.000000", "2026-01-02T03:04:05.000000Z"],
    ["2026-01-02 03:04:05.123456+00:00", "2026-01-02T03:04:05.123456Z"],
    ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05Z"],
    ["2026-01-02 01:30:00.250000+02:00", "2026-01-01T23:30:00.250000Z"],
    ["2026-12-31 23:30:00-01:00", "2027-01-01T00:30:00Z"],
    ["2024-02-28 23:00:00-01:00", "2024-02-29T00:00:00Z"],
  ])("%s -> %s", (stored, expected) => {
    expect(value(decodeTimestamp(stored))).toBe(expected);
    expect(TIMESTAMP_RE.test(expected)).toBe(true);
  });

  it.each([
    "2026-01-02",
    "2026-01-02 03:04",
    "2026-01-02 03:04:05.1234567",
    "2026-01-02 03:04:05+0200",
    "2026-01-02 24:00:00",
    "2026-02-30 00:00:00",
    "2026-01-02_03:04:05",
    " 2026-01-02 03:04:05",
    "0001-01-01 00:30:00+01:00",
  ])("refuses %j", (stored) => {
    expect(decodeTimestamp(stored)).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("refuses non-text", () => {
    expect(decodeTimestamp(1_700_000_000)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(decodeTimestamp(null)).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});

describe("decodeDate", () => {
  it("keeps a calendar date", () => {
    expect(value(decodeDate("2024-02-29"))).toBe("2024-02-29");
  });
  it.each(["2026-02-29", "2026-1-02", "2026-01-02 00:00:00", "20260102"])("refuses %j", (d) => {
    expect(decodeDate(d)).toEqual({ ok: false, reason: "bad_date" });
  });
});

describe("decodeDecimal", () => {
  it.each([
    ["10.50", "10.50"],
    ["-3", "-3"],
    ["0", "0"],
    ["-0", "-0"],
    ["0.00", "0.00"],
    ["1E+2", "100"],
    ["1.50E+3", "1500"],
    ["1.5E-7", "0.00000015"],
    ["0E-8", "0.00000000"],
    ["-2.5E-3", "-0.0025"],
    ["123456789012345678901234567890.123456789", "123456789012345678901234567890.123456789"],
  ])("%s -> %s", (stored, expected) => {
    expect(value(decodeDecimal(stored))).toBe(expected);
    expect(DECIMAL_RE.test(expected)).toBe(true);
  });

  it.each(["NaN", "Infinity", "-Infinity", "1,5", "1e2", " 1", "1_000", "", "+1", ".5"])(
    "refuses %j",
    (stored) => {
      expect(decodeDecimal(stored)).toEqual({ ok: false, reason: "bad_decimal" });
    },
  );

  it("refuses a REAL", () => {
    expect(decodeDecimal(1.5)).toEqual({ ok: false, reason: "bad_decimal" });
  });
});

describe("decodeSource", () => {
  it.each([
    ["OPEN_BANKING", "open_banking"],
    ["CSV", "csv"],
    ["MANUAL", "manual"],
    ["CONNECTOR", "connector"],
  ])("%s -> %s", (stored, expected) => {
    expect(value(decodeSource(stored))).toBe(expected);
  });
  it.each(["csv", "Csv", "SOMETHING", ""])("refuses %j (values are stored by NAME)", (stored) => {
    expect(decodeSource(stored)).toEqual({ ok: false, reason: "bad_enum" });
  });
});

describe("scalars", () => {
  it("decodes booleans 0 / 1 only", () => {
    expect(value(decodeBool(0))).toBe(false);
    expect(value(decodeBool(1))).toBe(true);
    expect(value(decodeBool(1n))).toBe(true);
    expect(decodeBool(2)).toEqual({ ok: false, reason: "bad_bool" });
    expect(decodeBool("1")).toEqual({ ok: false, reason: "bad_bool" });
  });
  it("decodes safe integers", () => {
    expect(value(decodeInt(7))).toBe(7);
    expect(value(decodeInt(7n))).toBe(7);
    expect(decodeInt(1.5)).toEqual({ ok: false, reason: "bad_int" });
    expect(decodeInt(2n ** 60n)).toEqual({ ok: false, reason: "bad_int" });
    expect(decodeInt("7")).toEqual({ ok: false, reason: "bad_int" });
  });
  it("decodes text", () => {
    expect(value(decodeText("abc"))).toBe("abc");
    expect(decodeText(3)).toEqual({ ok: false, reason: "bad_text" });
  });
});

describe("decodeJson", () => {
  const notNullObject = { nullable: false, empty: "object" } as const;
  const notNullList = { nullable: false, empty: "list" } as const;
  const nullable = { nullable: true, empty: "object" } as const;

  it("parses and counts nothing for plain JSON", () => {
    expect(decodeJson('{"a": [1, "x", true, null]}', notNullObject)).toEqual({
      ok: true,
      value: { value: { a: [1, "x", true, null] }, floats: 0, bigInts: 0 },
    });
  });

  it("maps SQL NULL and JSON null to null or the model default", () => {
    expect(value(decodeJson(null, nullable))).toEqual({ value: null, floats: 0, bigInts: 0 });
    expect(value(decodeJson("null", nullable))).toEqual({ value: null, floats: 0, bigInts: 0 });
    expect(value(decodeJson("null", notNullObject))).toEqual({ value: {}, floats: 0, bigInts: 0 });
    expect(value(decodeJson("null", notNullList))).toEqual({ value: [], floats: 0, bigInts: 0 });
  });

  it.each(['{"x": NaN}', '{"x": Infinity}', '{"x": -Infinity}', "{bad", "", "{'a': 1}"])(
    "refuses %j",
    (text) => {
      expect(decodeJson(text, notNullObject)).toEqual({ ok: false, reason: "bad_json" });
    },
  );

  it("refuses a non-text value", () => {
    expect(decodeJson(5, notNullObject)).toEqual({ ok: false, reason: "bad_json" });
  });

  it("counts float tokens and integers above 2^53, never inside strings", () => {
    const text =
      '{"r": 0.5, "w": 1.0, "e": 1e+20, "big": 9007199254740993, "neg": -9007199254740993,' +
      ' "edge": 9007199254740992, "s": "1.5 and 9007199254740993", "k\\"3.5": 2}';
    const r = decodeJson(text, notNullObject);
    expect(r.ok && r.value.floats).toBe(3);
    expect(r.ok && r.value.bigInts).toBe(2);
  });
});
