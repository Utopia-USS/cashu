// Guard of the log copy's field table (events.md 4.5): existing entries never change, every field of
// every registered schema version has a position. `CASHU_FIELD_TABLE=append` regenerates
// field-table.ts with the missing fields appended and the lock extended (never rewriting an entry).
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../modules.js";
import { EventRegistry } from "../registry.js";
import { FIELD_TABLE, FIELD_TABLE_LOCK } from "./field-table.js";

type Table = Readonly<Record<string, readonly string[]>>;
type Lock = Readonly<Record<string, string>>;

const APPEND = process.env.CASHU_FIELD_TABLE === "append";
const TABLE_FILE = new URL("./field-table.ts", import.meta.url);

/** FNV-1a (32 bit) of the names, one per line: detects an accidental edit, not an adversary. */
function fnv1a(names: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = names.join("\n");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function lockOf(names: readonly string[]): string {
  return `${names.length}:${fnv1a(names)}`;
}

/** Locked entries that no longer read as locked: removed, reordered, renamed, truncated. */
function brokenLocks(table: Table, lock: Lock): string[] {
  const out: string[] = [];
  for (const [type, pinned] of Object.entries(lock)) {
    const [count, hash] = pinned.split(":");
    const names = table[type];
    const n = Number(count);
    if (names === undefined) out.push(`${type}: table removed`);
    else if (names.length < n) out.push(`${type}: ${n - names.length} locked entries removed`);
    else if (fnv1a(names.slice(0, n)) !== hash) out.push(`${type}: locked entries changed`);
  }
  return out;
}

/** Entries the lock does not cover yet (appended by hand instead of by the append mode). */
function unlocked(table: Table, lock: Lock): string[] {
  return Object.entries(table)
    .filter(([type, names]) => Number(lock[type]?.split(":")[0] ?? -1) !== names.length)
    .map(([type]) => type);
}

/** Every top-level field of every version of every registered type, in version then schema order. */
function registeredFields(): Map<string, string[]> {
  const registry = EventRegistry.v1();
  for (const m of builtinModules()) for (const d of m.events ?? []) registry.define(d);
  const out = new Map<string, string[]>();
  for (const type of registry.types()) {
    const def = registry.get(type);
    const fields: string[] = [];
    for (const v of [...(def?.schemas.keys() ?? [])].sort((a, b) => a - b)) {
      const shape = (def?.schemas.get(v) as { shape?: Record<string, unknown> } | undefined)?.shape;
      for (const k of Object.keys(shape ?? {})) if (!fields.includes(k)) fields.push(k);
    }
    out.set(type, fields);
  }
  return out;
}

function missingFields(table: Table, fields: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const [type, names] of fields) {
    for (const k of names) if (!table[type]?.includes(k)) out.push(`${type}.${k}`);
  }
  return out;
}

/** The table with every missing field appended at the end of its type's entries. */
function appended(table: Table, fields: ReadonlyMap<string, readonly string[]>): Table {
  const out: Record<string, readonly string[]> = { ...table };
  for (const [type, names] of fields) {
    const have = out[type] ?? [];
    const add = names.filter((k) => !have.includes(k));
    if (add.length > 0 || out[type] === undefined) out[type] = [...have, ...add];
  }
  return out;
}

function render(table: Table): string {
  const types = Object.keys(table).sort();
  const rows = types.map((type) => {
    const names = table[type] ?? [];
    const one = `  ${JSON.stringify(type)}: [${names.map((k) => JSON.stringify(k)).join(", ")}],`;
    if (one.length <= 100) return one;
    return [
      `  ${JSON.stringify(type)}: [`,
      ...names.map((k) => `    ${JSON.stringify(k)},`),
      "  ],",
    ].join("\n");
  });
  const locks = types.map((type) => `  ${JSON.stringify(type)}: "${lockOf(table[type] ?? [])}",`);
  return [
    "// GENERATED, APPEND-ONLY: the field table of the log copy's positional payloads (events.md 4.5,",
    "// engine/compact.ts). Per event type, the field names in the order of their position in a stored",
    "// payload; one table serves every version of the type. Never edit, reorder or remove an entry:",
    "// stored payloads would decode into the wrong fields. A new schema field (any version, anywhere in",
    "// the schema) is appended by",
    "//   CASHU_FIELD_TABLE=append pnpm --filter @cashu/store exec vitest run src/engine/field-table.test.ts",
    "// which also extends FIELD_TABLE_LOCK (entries covered : FNV-1a of them); field-table.test.ts",
    "// fails when a locked entry changes.",
    "export const FIELD_TABLE: Readonly<Record<string, readonly string[]>> = {",
    ...rows,
    "};",
    "",
    "export const FIELD_TABLE_LOCK: Readonly<Record<string, string>> = {",
    ...locks,
    "};",
    "",
  ].join("\n");
}

describe("the lock", () => {
  const table = { "x.set": ["a", "b", "c"] };
  const lock = { "x.set": lockOf(["a", "b", "c"]) };

  it("holds for appended entries", () => {
    expect(brokenLocks({ "x.set": ["a", "b", "c", "d"] }, lock)).toEqual([]);
    expect(unlocked({ "x.set": ["a", "b", "c", "d"] }, lock)).toEqual(["x.set"]);
    expect(unlocked(table, lock)).toEqual([]);
  });

  it.each([
    ["reordered", ["b", "a", "c"]],
    ["renamed", ["a", "bb", "c"]],
    ["removed in the middle", ["a", "c"]],
    ["removed at the end", ["a", "b"]],
    ["inserted", ["a", "z", "b", "c"]],
  ])("breaks when an entry is %s", (_, names) => {
    expect(brokenLocks({ "x.set": names }, lock)).toHaveLength(1);
  });

  it("breaks when a type's table is removed", () => {
    expect(brokenLocks({}, lock)).toEqual(["x.set: table removed"]);
  });
});

describe.skipIf(APPEND)("the field table", () => {
  it("keeps every locked entry (append-only)", () => {
    expect(brokenLocks(FIELD_TABLE, FIELD_TABLE_LOCK)).toEqual([]);
  });

  it("is locked entirely (append with CASHU_FIELD_TABLE=append, never by hand)", () => {
    expect(unlocked(FIELD_TABLE, FIELD_TABLE_LOCK)).toEqual([]);
    expect(Object.keys(FIELD_TABLE_LOCK).filter((t) => FIELD_TABLE[t] === undefined)).toEqual([]);
  });

  it("has a position for every field of every registered schema version", () => {
    expect(missingFields(FIELD_TABLE, registeredFields())).toEqual([]);
  });

  it("names each field once per type", () => {
    for (const [type, names] of Object.entries(FIELD_TABLE)) {
      expect(new Set(names).size, type).toBe(names.length);
    }
  });
});

describe.runIf(APPEND)("append mode", () => {
  it("appends the missing fields and extends the lock", () => {
    expect(brokenLocks(FIELD_TABLE, FIELD_TABLE_LOCK)).toEqual([]);
    writeFileSync(TABLE_FILE, render(appended(FIELD_TABLE, registeredFields())));
  });
});
