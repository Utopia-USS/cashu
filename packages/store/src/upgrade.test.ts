// Forward compatibility (events.md 7): unknown types and newer versions are stored, not applied, and
// flagged; unknown fields are preserved and ignored; upcasters lift old payloads on read; an upgraded
// reader rebuilds and converges with a reader that was new from the start.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { storedBody } from "./engine/log.js";
import type { Materializer } from "./engine/types.js";
import { PAYLOADS } from "./events/v1/catalog.js";
import { builtinModules } from "./modules.js";
import type { StoreModule } from "./registry.js";
import { viewHash } from "./snapshot.js";
import { EventFactory, memoryDriver, openTestStore, TEST_VAULT } from "./testing/store.js";

const ITEM = "01JC0ZA1B2C3D4E5F6G7H8J9K0";

/** A test-only type: v1 `{text}`, v2 renames the field to `body` (a breaking change: bump + upcaster). */
const notesTable = {
  name: "test_notes",
  columns: [{ name: "body", type: "TEXT" as const, notNull: true }],
};

const notesV1: Materializer = {
  id: "test.notes",
  version: 1,
  tables: [notesTable],
  handles: ["testNote.set"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write("test_notes", "DELETE FROM test_notes WHERE gid = ?", g);
  },
  apply(e, ctx) {
    ctx.sql.write(
      "test_notes",
      "INSERT INTO test_notes (id, gid, body) VALUES (?, ?, ?) ON CONFLICT (gid) DO UPDATE SET body = excluded.body",
      ctx.id(e.gid),
      e.gid,
      String(e.data.text),
    );
  },
};

const notesV2: Materializer = {
  ...notesV1,
  version: 2,
  apply(e, ctx) {
    notesV1.apply({ ...e, data: { text: e.data.body } }, ctx);
  },
};

const meta = { table: "test_notes", rule: "LWW-F", gid: "ULID", emitter: "any" } as const;
const v1Module: StoreModule = {
  id: "test",
  materializers: [notesV1],
  events: [{ type: "testNote.set", v: 1, schema: z.looseObject({ text: z.string() }), meta }],
};
const v2Module: StoreModule = {
  id: "test",
  materializers: [notesV2],
  events: [
    { type: "testNote.set", v: 1, schema: z.looseObject({ text: z.string() }), meta },
    {
      type: "testNote.set",
      v: 2,
      schema: z.looseObject({ body: z.string() }),
      upcastFrom: ({ text, ...rest }) => ({ ...rest, body: text }),
    },
  ],
};

/**
 * A v2 of a catalog type whose schema lists the v1 fields in reverse order and inserts a new optional
 * field first: the log copy's positions come from the field table (events.md 4.5), not the schema.
 */
const reorderedRuleModule: StoreModule = {
  id: "test",
  materializers: [],
  events: [
    {
      type: "categoryRule.set",
      v: 2,
      schema: z.looseObject({
        confidence: z.number().optional(),
        ...Object.fromEntries(
          Object.entries(
            (PAYLOADS["categoryRule.set"] as unknown as { shape: Record<string, z.ZodType> }).shape,
          ).reverse(),
        ),
      }),
      upcastFrom: (d) => ({ ...d }),
    },
  ],
};

describe("forward compatibility", () => {
  it("parks an unknown type and a newer version, keeps them, flags needsUpgrade", () => {
    const store = openTestStore({ modules: [...builtinModules(), v1Module] });
    const f = new EventFactory();
    const r = store.applyEnvelopes([
      f.make("testNote.set", ITEM, { text: "old" }),
      f.make("testNote.set", ITEM, { body: "new" }, { v: 2 }),
      f.make("futureThing.happened", ITEM, { anything: 1 }),
    ]);
    expect(r).toMatchObject({ applied: 1, parked: 2, needsUpgrade: true });
    expect(store.needsUpgrade()).toBe(true);
    expect(store.read("SELECT type, v, reason, count FROM unknown_events ORDER BY type")).toEqual([
      { type: "futureThing.happened", v: 1, reason: "unknown-type", count: 1 },
      { type: "testNote.set", v: 2, reason: "newer-version", count: 1 },
    ]);
    expect(store.read("SELECT body FROM test_notes")).toEqual([{ body: "old" }]);
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 3 }]);
  });

  it("parks a known type whose payload fails validation (e.g. a new enum value)", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const r = store.applyEnvelopes([
      f.make("categoryRule.set", "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2", {
        merchantKey: "SKLEP TESTOWY",
        category: "groceries",
        source: "a_new_source",
        locked: false,
      }),
    ]);
    expect(r).toMatchObject({ applied: 0, parked: 1, needsUpgrade: true });
    expect(store.read("SELECT COUNT(*) AS n FROM category_rules")).toEqual([{ n: 0 }]);
  });

  it("preserves unknown envelope and payload fields in the log and ignores them in the fold", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const e = {
      ...f.make("categoryRule.set", "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2", {
        merchantKey: "SKLEP TESTOWY",
        category: "groceries",
        source: "manual",
        locked: true,
        confidence: 0.9,
      }),
      trace: { hop: 2 },
    };
    expect(store.applyEnvelopes([e]).applied).toBe(1);
    expect(store.read("SELECT category, locked FROM category_rules")).toEqual([
      { category: "groceries", locked: 1 },
    ]);
    const row = store.read<Parameters<typeof storedBody>[0]>("SELECT * FROM event_log")[0];
    expect(row && storedBody(row, TEST_VAULT)).toBe(canonicalJson(e));
    // re-delivery of the identical body is a duplicate, not a conflict
    expect(store.applyEnvelopes([e]).duplicates).toBe(1);
  });

  it("upcasts v1 to v2 on read, and an upgraded reader rebuilds to the new reader's view", () => {
    const f = new EventFactory();
    const events = [
      f.make("testNote.set", ITEM, { text: "first" }),
      f.make("testNote.set", ITEM, { body: "second" }, { v: 2 }),
    ];
    const fresh = openTestStore({ modules: [...builtinModules(), v2Module] });
    expect(fresh.applyEnvelopes(events)).toMatchObject({ applied: 2, parked: 0 });
    expect(fresh.read("SELECT body FROM test_notes")).toEqual([{ body: "second" }]);
    expect(fresh.read("SELECT data, raw_data, v FROM event_log ORDER BY hlc")).toEqual([
      { data: '{"body":"first"}', raw_data: '{"text":"first"}', v: 1 },
      { data: '{"body":"second"}', raw_data: null, v: 2 },
    ]);

    const driver = memoryDriver();
    const old = openTestStore({ driver, modules: [...builtinModules(), v1Module] });
    expect(old.applyEnvelopes(events)).toMatchObject({ applied: 1, parked: 1 });
    expect(old.read("SELECT body FROM test_notes")).toEqual([{ body: "first" }]);
    // the app upgrades: same database, new definitions -> rebuild with re-decode on open
    const upgraded = openTestStore({ driver, modules: [...builtinModules(), v2Module] });
    expect(upgraded.needsUpgrade()).toBe(false);
    expect(upgraded.read("SELECT body FROM test_notes")).toEqual([{ body: "second" }]);
    expect(viewHash(upgraded).hash).toBe(viewHash(fresh).hash);
  });

  it("reads stored payloads identically after an upgrade that reorders and grows the schema", () => {
    const RULE = "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2";
    const rule = { merchantKey: "SKLEP TESTOWY", category: "groceries", source: "manual" };
    const f = new EventFactory();
    const driver = memoryDriver();
    const old = openTestStore({ driver });
    old.applyEnvelopes([
      f.make("categoryRule.set", RULE, { ...rule, locked: false }),
      f.make("categoryRule.set", RULE, { ...rule, category: "transport", locked: true }),
    ]);
    type Row = Parameters<typeof storedBody>[0];
    const rows = () => old.read<Row>("SELECT * FROM event_log ORDER BY hlc");
    const before = rows();
    expect(before.map((r) => r.data?.startsWith("["))).toEqual([true, true]);
    const hash = viewHash(old).hash;

    const upgraded = openTestStore({ driver, modules: [...builtinModules(), reorderedRuleModule] });
    const after = upgraded.read<Row>("SELECT * FROM event_log ORDER BY hlc");
    expect(after.map((r) => [r.data, r.raw_data, r.state])).toEqual(
      before.map((r) => [r.data, r.raw_data, r.state]),
    );
    expect(after.map((r) => storedBody(r, TEST_VAULT))).toEqual(
      before.map((r) => storedBody(r, TEST_VAULT)),
    );
    expect(viewHash(upgraded).hash).toBe(hash);

    // a v2 event with the new field: no position for it in the table, so it keeps its names
    const v2 = f.make(
      "categoryRule.set",
      RULE,
      { ...rule, locked: true, confidence: 0.5 },
      { v: 2 },
    );
    expect(upgraded.applyEnvelopes([v2]).applied).toBe(1);
    const last = upgraded.read<Row>("SELECT * FROM event_log ORDER BY hlc DESC LIMIT 1")[0];
    expect(last && JSON.parse(last.data ?? "null")).toEqual({
      ...rule,
      locked: true,
      confidence: 0.5,
    });
    expect(upgraded.read("SELECT category, locked FROM category_rules")).toEqual([
      { category: "groceries", locked: 1 },
    ]);
  });
});
