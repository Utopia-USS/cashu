import { describe, expect, it } from "vitest";
import { CanonParseError, canonType, parseCanonical, sha256Hex } from "./json.ts";

describe("parseCanonical", () => {
  it("keeps integers as bigint and floats as number", () => {
    const v = parseCanonical('{"a":1,"b":1.0,"c":-0.5,"d":1e-05,"e":9007199254740993}');
    const o = v as Map<string, unknown>;
    expect(o.get("a")).toBe(1n);
    expect(o.get("b")).toBe(1);
    expect(canonType(o.get("a") as bigint)).toBe("int");
    expect(canonType(o.get("b") as number)).toBe("float");
    expect(o.get("c")).toBe(-0.5);
    expect(o.get("d")).toBe(0.00001);
    expect(o.get("e")).toBe(9007199254740993n);
  });

  it("parses strings with escapes, unicode and nested containers", () => {
    const v = parseCanonical('\n{"k":["a\\n\\"b\\"","zażółć",null,true,false,[],{}]}\n');
    const arr = (v as Map<string, unknown>).get("k") as unknown[];
    expect(arr[0]).toBe('a\n"b"');
    expect(arr[1]).toBe("zażółć");
    expect(arr.slice(2, 5)).toEqual([null, true, false]);
    expect(arr[5]).toEqual([]);
    expect((arr[6] as Map<string, unknown>).size).toBe(0);
  });

  it("treats __proto__ as an ordinary key", () => {
    const v = parseCanonical('{"__proto__":1}') as Map<string, unknown>;
    expect(v.get("__proto__")).toBe(1n);
  });

  it.each([
    ['{"a":1,"a":2}', "duplicate"],
    ['{"a":NaN}', "unexpected"],
    ['{"a":Infinity}', "unexpected"],
    ["[1,]", "unexpected"],
    ['{"a":1} x', "trailing"],
    ['{"a":01}', "expected"],
    ['"abc', "unterminated"],
    ["[1 2]", "expected"],
    ["", "unexpected"],
    ['{"a":1e999}', "out of range"],
  ])("rejects %s", (text, reason) => {
    expect(() => parseCanonical(text)).toThrow(CanonParseError);
    expect(() => parseCanonical(text)).toThrow(reason);
  });

  it("errors carry an offset and no input text", () => {
    try {
      parseCanonical('{"secret-merchant":@}');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CanonParseError);
      expect((e as CanonParseError).offset).toBeGreaterThan(0);
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("hashes bytes and text alike", () => {
    expect(sha256Hex("a")).toBe(sha256Hex(new TextEncoder().encode("a")));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
