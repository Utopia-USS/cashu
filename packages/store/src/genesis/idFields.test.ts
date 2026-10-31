/// <reference types="node" />
// S26 spec 6.5: the guard's id-key vocabulary stays equal to parity/python/canon.py `FIELD_TABLES`,
// plus the id-suffix rule and what counts as a local id inside JSON.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALERT_KEY_RE, idFieldTable, isJsonObject, KEY_PART_RE, rowIdOf } from "./idFields.js";

function canonFieldTables(): [string, string][] {
  const canon = readFileSync(
    new URL("../../../../parity/python/canon.py", import.meta.url),
    "utf8",
  );
  const start = canon.indexOf("FIELD_TABLES: dict[str, str] = {");
  const block = canon.slice(start, canon.indexOf("}", start));
  return [...block.matchAll(/"([a-z_]+)": "([a-z_]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]);
}

describe("idFieldTable", () => {
  it("knows every key of canon.py FIELD_TABLES with the same table", () => {
    const entries = canonFieldTables();
    expect(entries.length).toBeGreaterThan(30);
    for (const [key, table] of entries) expect(idFieldTable(key), key).toBe(table);
  });

  it("reads the common id suffixes, and nothing else", () => {
    expect(idFieldTable("previous_instrument_id")).toBe("inv_instruments");
    expect(idFieldTable("lead_note_ids")).toBe("research_notes");
    expect(idFieldTable("source_account_id")).toBe("accounts");
    expect(idFieldTable("binding_id")).toBeUndefined();
    expect(idFieldTable("accounts")).toBeUndefined();
    expect(idFieldTable("instrument")).toBeUndefined();
  });
});

describe("rowIdOf", () => {
  it.each([
    [7, 7],
    ["7", 7],
    [0, 0],
    ["07", undefined],
    ["0", undefined],
    [1.5, undefined],
    [true, undefined],
    [null, undefined],
    ["abc", undefined],
    ["99999999999999999999", undefined],
  ])("%j -> %j", (value, id) => {
    expect(rowIdOf(value)).toBe(id);
  });
});

describe("key patterns and JSON objects", () => {
  it("matches id key parts and whole alert keys only", () => {
    expect(KEY_PART_RE.exec("i:12")?.slice(1)).toEqual(["i", "12"]);
    expect(KEY_PART_RE.test("s:etf")).toBe(false);
    expect(ALERT_KEY_RE.exec("alert:3")?.[1]).toBe("3");
    expect(ALERT_KEY_RE.test("alert:3|i:1")).toBe(false);
  });

  it("tells objects from arrays and null", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});
