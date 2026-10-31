import { describe, expect, it } from "vitest";
import type { Decimal } from "./decimal.js";
import { isRecord, lineColumn, PyJsonError, parseJson, parsePyJson } from "./pyJson.js";

// `json.loads` messages as Python 3.14 words them (the importers print them); the replay of
// truncations and byte flips is `inv-importing-canonical` / `budget-canonical`.
function decodeError(text: string) {
  const result = parseJson(text);
  if (result.ok || result.kind !== "decode") throw new Error(`no decode error for ${text}`);
  return { msg: result.msg, ...lineColumn(text, result.pos) };
}

describe("JSONDecodeError messages", () => {
  it.each([
    ["{", "Expecting property name enclosed in double quotes", 1, 2],
    ["[1,", "Expecting value", 1, 4],
    ['{"a" 1}', "Expecting ':' delimiter", 1, 6],
    ['{"a":1,}', "Illegal trailing comma before end of object", 1, 7],
    ['"abc', "Unterminated string starting at", 1, 1],
    ['{"a":1}x', "Extra data", 1, 8],
    ["﻿{}", "Unexpected UTF-8 BOM (decode using utf-8-sig)", 1, 1],
    ["[1 2]", "Expecting ',' delimiter", 1, 4],
    ["[1,]", "Illegal trailing comma before end of array", 1, 3],
    ['"\\x"', "Invalid \\escape", 1, 2],
    ['"\\u12G4"', "Invalid \\uXXXX escape", 1, 3],
    ['"a\tb"', "Invalid control character at", 1, 3],
    ["\n\n  x", "Expecting value", 3, 3],
  ])("%j: %s at line %i, column %i", (text, msg, line, column) => {
    expect(decodeError(text)).toEqual({ msg, line, column });
  });
});

describe("importer options", () => {
  it("reads integers as Decimal when asked, exactly and without a digit limit", () => {
    const digits = "9".repeat(5000);
    const result = parseJson(`[${digits}, 1, 1.50, -0]`, { integers: "decimal" });
    expect(result.ok && Array.isArray(result.value)).toBe(true);
    const [big, one, float, negZero] = (result.ok ? result.value : []) as Decimal[];
    expect(big?.toString()).toBe(digits);
    expect([one?.toString(), float?.toString(), negZero?.toString()]).toEqual(["1", "1.50", "-0"]);
  });

  it("refuses an over-long integer by default (Python's 4300-digit limit)", () => {
    const result = parseJson(`[${"9".repeat(5000)}]`);
    expect(result).toMatchObject({ ok: false, kind: "value", reason: "int_digits" });
  });

  it("names NaN and Infinity and the repeated key", () => {
    expect(parseJson("[NaN]")).toMatchObject({ kind: "value", reason: "constant", detail: "NaN" });
    expect(parseJson("[-Infinity]")).toMatchObject({ detail: "-Infinity" });
    expect(parseJson('{"a":1,"a":2}')).toMatchObject({ kind: "duplicate_key", key: "a" });
  });

  it("refuses nesting no real document has instead of overflowing the stack", () => {
    // PARITY(S17a): Python 3.14 reads about 10^5 levels; documents nest 3.
    const result = parseJson("[".repeat(50_000));
    expect(result).toMatchObject({ ok: false, kind: "value", reason: "depth" });
  });
});

describe("parsePyJson (json.loads defaults, same scanner)", () => {
  it("accepts NaN and the infinities, keeps the last of a repeated key and reads plain records", () => {
    const value = parsePyJson('{"a":NaN,"b":[Infinity,-Infinity],"a":2,"__proto__":1}');
    expect(isRecord(value)).toBe(true);
    const record = value as Record<string, unknown>;
    expect(record.a).toBe(2);
    expect(record.b).toEqual([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    expect(Object.keys(record)).toEqual(["a", "b", "__proto__"]);
    expect(parsePyJson("NaN")).toBeNaN();
  });

  it("hands every number literal to the hook, telling integers from floats", () => {
    const seen: [string, boolean][] = [];
    parsePyJson("[1, -2.50, 3e2, 0]", (text, integer) => {
      seen.push([text, integer]);
      return 0;
    });
    expect(seen).toEqual([
      ["1", true],
      ["-2.50", false],
      ["3e2", false],
      ["0", true],
    ]);
  });

  it("refuses what the strict grammar refuses, as a PyJsonError with Python's message", () => {
    expect(() => parsePyJson("[1,]")).toThrow(PyJsonError);
    expect(() => parsePyJson("[1,]")).toThrow(
      "Illegal trailing comma before end of array: line 1 column 3 (char 2)",
    );
    expect(() => parsePyJson("[".repeat(50_000))).toThrow(PyJsonError);
  });
});
