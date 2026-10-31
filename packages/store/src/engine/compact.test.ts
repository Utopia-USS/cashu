import { describe, expect, it } from "vitest";
import { PAYLOADS } from "../events/v1/catalog.js";
import { VALID_SAMPLES } from "../events/v1/test-fixtures.js";
import { decodePayload, encodePayload } from "./compact.js";

describe("compact log payloads", () => {
  it("round-trips every catalog sample positionally", () => {
    for (const type of Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[]) {
      const data = PAYLOADS[type].parse(VALID_SAMPLES[type]) as Record<string, unknown>;
      const text = encodePayload(type, data);
      expect(text.startsWith("["), type).toBe(true);
      expect(decodePayload(type, text), type).toEqual(data);
    }
  });

  it("keeps absent and null apart, and stamps", () => {
    const type = "watchlist.added";
    const absent = { instrument: "x", source: "user" };
    const nulled = { instrument: "x", source: "user", note: null, stamps: { added_at: null } };
    expect(decodePayload(type, encodePayload(type, absent))).toStrictEqual(absent);
    expect(decodePayload(type, encodePayload(type, nulled))).toStrictEqual(nulled);
  });

  it("keeps field names for unknown fields and types outside the catalog", () => {
    const extra = { instrument: "x", source: "user", future: 1 };
    expect(encodePayload("watchlist.added", extra)).toBe(JSON.stringify(extra));
    expect(decodePayload("watchlist.added", JSON.stringify(extra))).toEqual(extra);
    expect(encodePayload("future.thing", { a: 1 })).toBe('{"a":1}');
  });

  it("is smaller than the named form for a transaction import", () => {
    const data = VALID_SAMPLES["txn.imported"];
    expect(encodePayload("txn.imported", data).length).toBeLessThan(
      JSON.stringify(data).length * 0.75,
    );
  });
});
