import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PAYLOADS } from "../events/v1/catalog.js";
import { VALID_SAMPLES } from "../testing/event-fixtures.js";
import { decodePayload, encodePayload, PayloadCodec } from "./compact.js";

const shapeOf = (schema: unknown) => (schema as { shape: Record<string, z.ZodType> }).shape;

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

  it("keeps field names for unknown fields and types outside the table", () => {
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

describe("independence from schema field order (events.md 4.5)", () => {
  // Rows as the S23b encoder wrote them (positions = the v1 schema order of that commit): they must
  // decode to the same payload for as long as the store reads its log copy.
  it.each([
    [
      "txn.imported",
      '[32767,"70cc61c8-79b5-80ae-b8cc-fdca7caef49e","01JC0ZA1B2C3D4E5F6G7H8J9K0","2026-01-15",null,"-12.50","PLN","Sklep Testowy",null,"zakup testowy",null,null,"csv","2568e841250298bd2055a257b85edbbc85c62f4d",0,{"#Data operacji":"2026-01-15"}]',
      VALID_SAMPLES["txn.imported"],
    ],
    ["signal.closed", '[3,"expired","mute"]', { status: "expired", reason: "mute" }],
    [
      "signal.closed",
      '[27,"resolved","x",null,{"a":1}]',
      { status: "resolved", reason: "x", run: null, payloadSet: { a: 1 } },
    ],
    [
      "watchlist.added",
      '[15,"fc9daa13-f073-8a72-8cd0-c1345436bc05",null,[],"user"]',
      { instrument: "fc9daa13-f073-8a72-8cd0-c1345436bc05", note: null, tags: [], source: "user" },
    ],
    [
      "categoryRule.set",
      '[15,"sklep testowy","groceries","manual",true]',
      { merchantKey: "sklep testowy", category: "groceries", source: "manual", locked: true },
    ],
  ])("decodes a stored %s row identically", (type, stored, payload) => {
    expect(decodePayload(type, stored)).toStrictEqual(payload);
  });

  it("encodes a payload parsed by a reordered schema to the same row", () => {
    const type = "txn.imported";
    const reordered = z.looseObject(
      Object.fromEntries(Object.entries(shapeOf(PAYLOADS[type])).reverse()),
    );
    const data = PAYLOADS[type].parse(VALID_SAMPLES[type]) as Record<string, unknown>;
    const viaReordered = reordered.parse(VALID_SAMPLES[type]) as Record<string, unknown>;
    expect(Object.keys(viaReordered)).not.toEqual(Object.keys(data));
    expect(encodePayload(type, viaReordered)).toBe(encodePayload(type, data));
  });

  it("keeps old rows when a schema is reordered and grows anywhere (table appended)", () => {
    // v1 {a, b, c}; the evolved schema inserts `d` first and reorders: the table only appends `d`.
    const v1 = z.looseObject({ a: z.string(), b: z.string().optional(), c: z.number() });
    const evolved = z.looseObject({
      d: z.boolean().optional(),
      c: z.number(),
      a: z.string(),
      b: z.string().optional(),
    });
    const before = new PayloadCodec({ "x.set": ["a", "b", "c"] });
    const after = new PayloadCodec({ "x.set": ["a", "b", "c", "d"] });
    const old = v1.parse({ a: "one", c: 3 }) as Record<string, unknown>;
    const stored = before.encode("x.set", old);
    expect(stored).toBe('[5,"one",3]');
    expect(after.decode("x.set", stored)).toStrictEqual(old);
    expect(after.encode("x.set", evolved.parse(old) as Record<string, unknown>)).toBe(stored);

    const fresh = evolved.parse({ d: true, c: 4, a: "two", b: "bee" }) as Record<string, unknown>;
    const text = after.encode("x.set", fresh);
    expect(text).toBe('[15,"two","bee",4,true]');
    expect(after.decode("x.set", text)).toStrictEqual({ a: "two", b: "bee", c: 4, d: true });
  });

  it("refuses a row whose values do not match its table (an edited table)", () => {
    const truncated = new PayloadCodec({ "x.set": ["a", "b"] });
    expect(() => truncated.decode("x.set", '[5,"one",3]')).toThrow(/does not match its table/);
    expect(() => truncated.decode("y.set", "[1,2]")).toThrow(/without a table/);
  });

  it("keeps names for a field past the mask's 52 positions", () => {
    const fields = Array.from({ length: 60 }, (_, i) => `f${i}`);
    const codec = new PayloadCodec({ "wide.set": fields });
    expect(codec.encode("wide.set", { f0: 1, f51: 2 })).toBe(`[${2 ** 51 + 1},1,2]`);
    expect(codec.decode("wide.set", codec.encode("wide.set", { f0: 1, f51: 2 }))).toEqual({
      f0: 1,
      f51: 2,
    });
    expect(codec.encode("wide.set", { f0: 1, f55: 2 })).toBe('{"f0":1,"f55":2}');
  });
});
