import { describe, expect, it } from "vitest";
import { compare, DEFAULT_OPTIONS, floatsEqual, pathKey } from "./compare.ts";
import { parseCanonical } from "./json.ts";

const diff = (g: string, a: string, opts = DEFAULT_OPTIONS) =>
  compare(parseCanonical(g), parseCanonical(a), opts);

describe("compare", () => {
  it("equal documents have no difference", () => {
    const text = '{"a":[1,2.5,"x",null,true],"b":{"c":"1.00"}}';
    expect(diff(text, text)).toBeNull();
  });

  it("ignores key order and insignificant whitespace", () => {
    expect(
      diff('{"a":1,"b":{"x":[1,2],"y":"s"}}', '{ "b": {"y":"s", "x":[1,2]}, "a":1 }'),
    ).toBeNull();
  });

  it("keeps array order significant", () => {
    expect(diff('{"a":[1,2]}', '{"a":[2,1]}')).toEqual({ path: "$.a[0]", kind: "int" });
  });

  describe("decimal strings", () => {
    it("match exactly by default", () => {
      expect(diff('{"v":"1.0"}', '{"v":"1.00"}')).toEqual({ path: "$.v", kind: "string" });
      expect(diff('{"v":"1E+1"}', '{"v":"10"}')).toEqual({ path: "$.v", kind: "string" });
    });

    it("compare by value with the numeric policy, without a tolerance", () => {
      const numeric = { ...DEFAULT_OPTIONS, decimal: "numeric" as const };
      expect(diff('{"v":"1.0"}', '{"v":"1.00"}', numeric)).toBeNull();
      expect(diff('{"v":"1E+1"}', '{"v":"10"}', numeric)).toBeNull();
      expect(diff('{"v":"1.0"}', '{"v":"1.0000000001"}', numeric)).toEqual({
        path: "$.v",
        kind: "string",
      });
      expect(diff('{"v":"abc"}', '{"v":"abd"}', numeric)).toEqual({ path: "$.v", kind: "string" });
    });
  });

  describe("floats", () => {
    it("accept differences within the absolute tolerance", () => {
      expect(diff('{"v":0.1}', '{"v":0.10000000005}')).toBeNull();
    });

    it("accept differences within the relative tolerance", () => {
      expect(diff('{"v":1000000.0}', '{"v":1000000.0000000005}')).toBeNull();
    });

    it("reject differences outside both tolerances", () => {
      expect(diff('{"v":0.1}', '{"v":0.1000001}')).toEqual({ path: "$.v", kind: "float" });
      expect(diff('{"v":1000000.0}', '{"v":1000000.01}')).toEqual({ path: "$.v", kind: "float" });
    });

    it("honour overridden tolerances", () => {
      const loose = { ...DEFAULT_OPTIONS, absTol: 1e-3 };
      expect(diff('{"v":0.1}', '{"v":0.1000001}', loose)).toBeNull();
      const exact = { ...DEFAULT_OPTIONS, absTol: 0, relTol: 0 };
      expect(diff('{"v":0.1}', '{"v":0.10000000005}', exact)).toEqual({
        path: "$.v",
        kind: "float",
      });
    });

    it("compares an integer with a float as numbers, but integers exactly", () => {
      expect(diff('{"v":1.0}', '{"v":1}')).toBeNull();
      expect(diff('{"v":1}', '{"v":1.0}')).toBeNull();
      expect(diff('{"v":9007199254740993}', '{"v":9007199254740992}')).toEqual({
        path: "$.v",
        kind: "int",
      });
    });

    it("floatsEqual is symmetric", () => {
      expect(floatsEqual(1e-10, 0, 1e-9, 1e-12)).toBe(true);
      expect(floatsEqual(0, 1e-10, 1e-9, 1e-12)).toBe(true);
      expect(floatsEqual(0, 1e-8, 1e-9, 1e-12)).toBe(false);
    });
  });

  describe("first difference", () => {
    it("reports the path of a planted diff and never the values", () => {
      const golden =
        '{"rows":[{"merchant":"SECRET-SHOP","amount":"12.34"},{"merchant":"x","amount":"5.00"}]}';
      const actual =
        '{"rows":[{"merchant":"SECRET-SHOP","amount":"12.34"},{"merchant":"x","amount":"5.01"}]}';
      const d = diff(golden, actual);
      expect(d).toEqual({ path: "$.rows[1].amount", kind: "string" });
      expect(JSON.stringify(d)).not.toMatch(/5\.0|SECRET|12\.34/);
    });

    it("reports in sorted-key order", () => {
      expect(diff('{"b":1,"a":1}', '{"b":2,"a":2}')?.path).toBe("$.a");
    });

    it("names missing and extra keys", () => {
      expect(diff('{"a":1,"b":2}', '{"a":1}')).toEqual({ path: "$.b", kind: "missing-key" });
      expect(diff('{"a":1}', '{"a":1,"b":2}')).toEqual({ path: "$.b", kind: "extra-key" });
    });

    it("names the types of a type mismatch, not the values", () => {
      expect(diff('{"a":"1"}', '{"a":1}')).toEqual({
        path: "$.a",
        kind: "type",
        detail: "string vs int",
      });
      expect(diff('{"a":null}', '{"a":[]}')).toEqual({
        path: "$.a",
        kind: "type",
        detail: "null vs array",
      });
    });

    it("reports a length difference after equal common elements", () => {
      expect(diff('{"a":[1,2]}', '{"a":[1,2,3]}')).toEqual({
        path: "$.a",
        kind: "length",
        detail: "2 vs 3",
      });
    });

    it("compares booleans", () => {
      expect(diff("[true]", "[false]")).toEqual({ path: "$[0]", kind: "boolean" });
    });
  });

  describe("path keys", () => {
    it("prints schema-like keys and hashes everything that could be data", () => {
      const nk = "account:0123456789abcdef";
      expect(pathKey("net_worth")).toBe("net_worth");
      expect(pathKey("$label")).toBe("$label");
      expect(pathKey("PLN")).toBe("PLN");
      expect(pathKey("2026-10")).toBe("2026-10");
      expect(pathKey(nk)).toBe(nk);
      expect(pathKey("Biedronka Sp. z o.o.")).toMatch(/^<key:[0-9a-f]{8}>$/);
      expect(pathKey("Biedronka Sp. z o.o.")).toBe(pathKey("Biedronka Sp. z o.o."));
      expect(pathKey("PL61109010140000071219812874")).toMatch(/^<key:/);
      expect(pathKey("net_worth", true)).toMatch(/^<key:/);
    });

    it("never leaks a data key in a reported path", () => {
      const d = diff('{"Kowalski Jan":{"v":1}}', '{"Kowalski Jan":{"v":2}}');
      expect(d?.path).toMatch(/^\$\.<key:[0-9a-f]{8}>\.v$/);
      expect(d?.path).not.toContain("Kowalski");
      const hashed = diff('{"v":1}', '{"v":2}', { ...DEFAULT_OPTIONS, hashKeys: true });
      expect(hashed?.path).toMatch(/^\$\.<key:[0-9a-f]{8}>$/);
    });
  });
});
