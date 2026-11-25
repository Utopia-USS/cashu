// The derivation `deriveLater` applies owe (`derive_owed` in `store_meta`, materialize.ts header) across
// everything else that touches the view: a record that does not decode, a snapshot export, a rebuild, a
// full and a partial view upgrade, a reset, a command between two parts, and a crash inside the final
// derive. The oracle is always a store that applied the same events in one transaction (and one with
// the same module definitions): the view hash, every companion table and `rederive()` changing
// nothing. Synthetic data only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Deriver } from "./engine/types.js";
import { toWire } from "./events/v1/envelope.js";
import type { Store } from "./materialize.js";
import { builtinModules } from "./modules.js";
import type { StoreModule } from "./registry.js";
import { exportSnapshot, importSnapshot, viewHash } from "./snapshot.js";
import { monthTables } from "./testing/months-oracle.js";
import { recurringState } from "./testing/recurring-oracle.js";
import { recurringScript } from "./testing/recurring-script.js";
import { Names, toEnvelopes } from "./testing/scenario-bridge.js";
import { syntheticDet } from "./testing/scenarios.js";
import { searchIndex } from "./testing/search-oracle.js";
import {
  memoryDriver,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
} from "./testing/store.js";
import { bumpVersion } from "./testing/upgrade.js";

const KEY = "derive_owed";

interface Part {
  readonly envelopes: readonly TestEnvelope[];
  readonly batch: { readonly device: string; readonly events: ReturnType<typeof toWire>[] };
}

/** Cut `envs` into one-device parts of at most `size` events, in order. */
function partsOf(envs: readonly TestEnvelope[], size: number): Part[] {
  const parts: Part[] = [];
  let run: TestEnvelope[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const device = run[0]?.device as string;
    parts.push({ envelopes: run, batch: { device, events: run.map((e) => toWire(e)) } });
    run = [];
  };
  for (const e of envs) {
    if (run.length > 0 && (run[0]?.device !== e.device || run.length >= size)) flush();
    run.push(e);
  }
  flush();
  return parts;
}

/** Every table a deriver owns that the view hash leaves out, as rows. */
function companionTables(store: Store): unknown {
  return {
    months: monthTables(store),
    recurring: recurringState(store),
    search: searchIndex(store),
  };
}

/** The first sampled recurring script whose derived tables are not empty, cut into parts. */
const PARTS: Part[] = (() => {
  const empty = JSON.stringify(companionTables(openTestStore()));
  for (const events of fc.sample(recurringScript, { numRuns: 50, seed: 4242 })) {
    const parts = partsOf(toEnvelopes(events, new Names(), syntheticDet(events)), 6);
    const one = openTestStore();
    one.applyWireBatches(parts.map((p) => p.batch));
    if (parts.length >= 4 && JSON.stringify(companionTables(one)) !== empty) return parts;
  }
  throw new Error("no script with derived rows");
})();

/** The oracle: every part applied in one transaction, under `modules`. */
function oneTransaction(modules?: readonly StoreModule[], parts: readonly Part[] = PARTS): Store {
  const store = openTestStore(modules ? { modules } : {});
  store.applyWireBatches(parts.map((p) => p.batch));
  return store;
}

function owedRecord(store: Store): string | undefined {
  return store.driver
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get<{ value: string }>(KEY)?.value;
}

function writeOwed(store: Store, value: string): void {
  store.driver
    .prepare(
      "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .run(KEY, value);
}

/** `parts` applied each in its own transaction, every one owing its derivation. */
function owe(store: Store, parts: readonly Part[] = PARTS): void {
  for (const p of parts) store.applyWireBatches([p.batch], { deriveLater: true });
}

/** The derived state lags `oracle` (so a test that settles it shows something). */
function expectLagging(store: Store, oracle: Store): void {
  expect(owedRecord(store)).toBeDefined();
  expect(companionTables(store)).not.toEqual(companionTables(oracle));
}

/** Fully derived, equal to `oracle`, nothing owed. */
function expectDerivedLike(store: Store, oracle: Store): void {
  expect(owedRecord(store)).toBeUndefined();
  expect(viewHash(store).hash).toBe(viewHash(oracle).hash);
  expect(companionTables(store)).toEqual(companionTables(oracle));
  expect(store.rederive().touchedTables).toEqual(new Set());
}

describe("an owed-derivation record that does not decode is never fatal", () => {
  const valid = JSON.stringify({ v: 1, dirty: {}, touched: [] });
  it.each([
    ["corrupt JSON", '{"v":1,"dirty":{"budget.transactions":["'],
    ["not an object", "[]"],
    [
      "wrong shape (partitions as a number)",
      '{"v":1,"dirty":{"budget.transactions":5},"touched":[]}',
    ],
    ["wrong shape (renamed field)", '{"v":1,"partitions":{},"touched":[]}'],
    ["unknown version", valid.replace('"v":1', '"v":2')],
  ])("%s: the open re-derives everything and drops the record", (_, raw) => {
    const oracle = oneTransaction();
    const store = openTestStore();
    owe(store);
    expectLagging(store, oracle);
    // What the record held is lost: only a full derivation can catch up.
    writeOwed(store, raw);
    const reopened = openTestStore({ driver: store.driver });
    expectDerivedLike(reopened, oracle);
  });

  it("an owing apply that finds one owes everything instead, and the next deriving apply pays it", () => {
    const oracle = oneTransaction();
    const store = openTestStore();
    owe(store, PARTS.slice(0, -1));
    writeOwed(store, "garbage");
    owe(store, PARTS.slice(-1));
    const record = JSON.parse(owedRecord(store) as string) as { dirty: Record<string, unknown> };
    expect(Object.values(record.dirty)).not.toHaveLength(0);
    expect(new Set(Object.values(record.dirty))).toEqual(new Set(["all"]));
    store.applyWireBatches([]);
    expectDerivedLike(store, oracle);
  });

  it("a garbage record on a store that owes nothing opens to the same state", () => {
    const oracle = oneTransaction();
    const store = oneTransaction();
    writeOwed(store, "\u0000not json");
    expectDerivedLike(openTestStore({ driver: store.driver }), oracle);
  });
});

describe("the owed derivation across the rest of the store", () => {
  it("a snapshot exported while a derivation is owed pays it first and imports", () => {
    const oracle = oneTransaction();
    const store = openTestStore();
    owe(store);
    expectLagging(store, oracle);
    const snapshot = exportSnapshot(store);
    expect(snapshot.viewHash).toBe(viewHash(oracle).hash);
    expectDerivedLike(store, oracle);
    const imported = importSnapshot(
      {
        driver: memoryDriver(),
        vault: TEST_VAULT,
        salt: TEST_SALT,
        modules: builtinModules(),
        companionReads: true,
      },
      snapshot,
    );
    expectDerivedLike(imported, oracle);
  });

  it("a rebuild derives everything and drops the record", () => {
    const oracle = oneTransaction();
    const store = openTestStore();
    owe(store);
    expectLagging(store, oracle);
    store.rebuild();
    expectDerivedLike(store, oracle);
    expectDerivedLike(openTestStore({ driver: store.driver }), oracle);
  });

  it("a full view upgrade at open derives everything and drops the record", () => {
    const store = openTestStore();
    owe(store);
    expectLagging(store, oneTransaction());
    const bumped = bumpVersion(builtinModules(), "budget.transactions");
    const upgraded = openTestStore({ driver: store.driver, modules: bumped });
    expect(upgraded.lastRebuild).toMatchObject({ scope: "full" });
    expectDerivedLike(upgraded, oneTransaction(bumped));
  });

  it("a partial view upgrade at open keeps the record and the open pays it after the upgrade", () => {
    const store = openTestStore();
    owe(store);
    expectLagging(store, oneTransaction());
    // Only the month aggregates re-derive in the upgrade: the categories, recurring payments and
    // search index stay owed and are settled by the open.
    const bumped = bumpVersion(builtinModules(), "budget.months");
    const upgraded = openTestStore({ driver: store.driver, modules: bumped });
    expect(upgraded.lastRebuild).toMatchObject({ scope: "partial", derivers: ["budget.months"] });
    expectDerivedLike(upgraded, oneTransaction(bumped));
  });

  it("a reset drops the record with the view; the replay derives as one transaction", () => {
    const oracle = oneTransaction();
    const store = openTestStore();
    owe(store);
    store.reset();
    expect(owedRecord(store)).toBeUndefined();
    store.applyWireBatches(PARTS.map((p) => p.batch));
    expectDerivedLike(store, oracle);
  });

  it("a command between two parts pays what is owed with its own derivation", () => {
    const oracle = oneTransaction();
    const store = openTestStore();
    const [first, second, ...rest] = PARTS;
    if (first === undefined || second === undefined) throw new Error("too few parts");
    owe(store, [first]);
    expect(owedRecord(store)).toBeDefined();
    // The in-process writer: logical envelopes, one deriving transaction.
    store.applyEnvelopes(second.envelopes);
    expect(owedRecord(store)).toBeUndefined();
    expect(store.rederive().touchedTables).toEqual(new Set());
    owe(store, rest);
    expectLagging(store, oracle);
    // A kill after the last owing part: the next open pays it.
    expectDerivedLike(openTestStore({ driver: store.driver }), oracle);
  });

  it("a crash inside the final derive rolls the part back, keeps the record, and the next open pays it", () => {
    let boom = false;
    // The first deriver writes its share, then fails: the whole transaction must roll back.
    const failing = (d: Deriver, first: boolean): Deriver => ({
      ...d,
      derive(dirty, ctx) {
        d.derive(dirty, ctx);
        if (boom && first) throw new Error("deriver failed");
      },
      deriveAll(ctx) {
        d.deriveAll(ctx);
        if (boom && first) throw new Error("deriver failed");
      },
    });
    let seen = false;
    const modules: StoreModule[] = builtinModules().map((m) => ({
      ...m,
      ...(m.derivers
        ? {
            derivers: m.derivers.map((d) => {
              const isFirst = !seen;
              seen = true;
              return failing(d, isFirst);
            }),
          }
        : {}),
    }));
    const oracle = oneTransaction(modules);
    const store = openTestStore({ modules });
    owe(store, PARTS.slice(0, -1));
    const record = owedRecord(store);
    const logged = () =>
      store.driver.prepare("SELECT COUNT(*) AS n FROM event_log").get<{ n: number }>()?.n;
    const before = {
      logged: logged(),
      companion: companionTables(store),
      hash: viewHash(store).hash,
    };
    expect(companionTables(store)).not.toEqual(companionTables(oracle));
    boom = true;
    const last = PARTS.at(-1) as Part;
    expect(() => store.applyWireBatches([last.batch])).toThrow("deriver failed");
    // Rolled back: the last part's events, the derivers' writes and the record's removal.
    expect(owedRecord(store)).toBe(record);
    expect(logged()).toBe(before.logged);
    expect(companionTables(store)).toEqual(before.companion);
    expect(viewHash(store).hash).toBe(before.hash);
    boom = false;
    // The next open pays what the owing parts left (the engine then delivers the last part again).
    const reopened = openTestStore({ driver: store.driver, modules });
    expectDerivedLike(reopened, oneTransaction(modules, PARTS.slice(0, -1)));
    reopened.applyWireBatches([last.batch]);
    expectDerivedLike(reopened, oracle);
  });
});
