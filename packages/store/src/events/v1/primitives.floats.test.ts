// Numbers in event data (events.md 4.3): integers only, floats as decimal text with their paths.
import { ownBatchDigest, type UnstampedEvent } from "@cashu/sync";
import { describe, expect, it } from "vitest";
import { eventBlob, eventNumber, nonIntegerNumberPath, restoreFloats } from "./primitives.js";

describe("event numbers", () => {
  it("keeps safe integers and writes any other number as Python's float text", () => {
    expect(eventNumber(3)).toBe(3);
    expect(eventNumber(-12)).toBe(-12);
    expect(eventNumber(0.5)).toBe("0.5");
    expect(eventNumber(-0.25)).toBe("-0.25");
    expect(eventNumber(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(eventNumber(1e-7)).toBe("0.0000001");
    expect(eventNumber(2 ** 53)).toBe("9007199254740992.0"); // Python repr of the float
    expect(() => eventNumber(Number.NaN)).toThrow(RangeError);
    expect(() => eventNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("writes a blob's floats as text, lists their paths and restores the same numbers", () => {
    const rule = {
      id: "agent_cash_half",
      kind: "cash_level",
      params: { max_weight: 0.5, min_weight: 0, bands: [0.05, 2], tags: ["a"] },
      note: "0.5",
    };
    const data = eventBlob("payload", { rule, backtest: { episodes: 2 } });
    expect(data).toEqual({
      payload: {
        rule: {
          ...rule,
          params: { max_weight: "0.5", min_weight: 0, bands: ["0.05", 2], tags: ["a"] },
        },
        backtest: { episodes: 2 },
      },
      payloadFloats: [
        ["rule", "params", "max_weight"],
        ["rule", "params", "bands", "0"],
      ],
    });
    expect(nonIntegerNumberPath(data)).toBeNull();
    expect(restoreFloats(data.payload, data.payloadFloats)).toEqual({
      rule,
      backtest: { episodes: 2 },
    });
    // Restoring copies: the stored blob is not changed.
    expect(
      (data.payload as { rule: { params: { max_weight: unknown } } }).rule.params.max_weight,
    ).toBe("0.5");
  });

  it("adds no sibling for an integer-only blob and keeps text that only looks numeric", () => {
    expect(eventBlob("params", { window_days: 20, level: "10.5" })).toEqual({
      params: { window_days: 20, level: "10.5" },
    });
    const stored = { level: "10.5" };
    expect(restoreFloats(stored, undefined)).toBe(stored);
    expect(
      restoreFloats({ a: { b: "x" }, c: "0.5" }, [["a", "b"], ["missing", "x"], ["a"]]),
    ).toEqual({ a: { b: "x" }, c: "0.5" });
  });

  it("keeps a __proto__ key an agent sent as plain data", () => {
    const params = JSON.parse('{"__proto__": {"x": 0.5}}') as Record<string, unknown>;
    const data = eventBlob("params", params);
    expect(Object.keys(data.params as object)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(data.params)).toBe(Object.prototype);
    expect(JSON.stringify(restoreFloats(data.params, data.paramsFloats))).toBe(
      JSON.stringify(params),
    );
  });

  it("names the first number event data may not carry", () => {
    expect(nonIntegerNumberPath({ a: [1, { b: 0.5 }] })).toBe("data.a[1].b");
    expect(nonIntegerNumberPath({ big: 2 ** 53 })).toBe("data.big");
    expect(nonIntegerNumberPath({ a: [1, "0.5"] })).toBeNull();
  });

  it("gives the native batch proof the integer-only JSON it requires", () => {
    const event = (d: Record<string, unknown>): UnstampedEvent => ({
      t: "proposal.created",
      v: 1,
      i: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      d,
    });
    expect(() => ownBatchDigest([event({ payload: { max_weight: 0.5 } })])).toThrow(
      "batch proof requires canonical JSON",
    );
    expect(ownBatchDigest([event(eventBlob("payload", { max_weight: 0.5 }))])).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
