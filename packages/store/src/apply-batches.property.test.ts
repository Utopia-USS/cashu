// Property: one `applyWireBatches` call of several batches derives exactly what one call per batch
// derives (W4 first-sync cost: the derivers run once per transaction, over the union of the batches'
// dirty partitions, instead of after every batch). Random budget scripts (categories, recurring,
// transfers), delivered in a seeded order with duplicates, cut into batches of one device each; the
// same batches applied one per call (the oracle: the derivers after every batch, as before) and
// grouped into calls of up to five. Compared: the view hash, every companion table (out of the hash:
// month aggregates, recurring records, the search index), the domain recomputes, and the derived
// oracle (`rederive` changes nothing). Synthetic data only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toWire } from "./events/v1/envelope.js";
import type { Store } from "./materialize.js";
import { viewHash } from "./snapshot.js";
import { expectCategoriesRecomputed } from "./testing/categories-oracle.js";
import { categoryScript as categories, type categoryScript } from "./testing/category-script.js";
import { expectMonthsRecomputed, monthTables } from "./testing/months-oracle.js";
import { chunked, rng, shuffled } from "./testing/random.js";
import { expectRecurringRecomputed, recurringState } from "./testing/recurring-oracle.js";
import { recurringScript } from "./testing/recurring-script.js";
import type { RefEvent } from "./testing/scenario-bridge.js";
import { Names, toEnvelopes } from "./testing/scenario-bridge.js";
import { syntheticDet } from "./testing/scenarios.js";
import { expectSearchIndexed, searchIndex } from "./testing/search-oracle.js";
import { openTestStore, type TestEnvelope } from "./testing/store.js";
import { transferScript } from "./testing/transfer-script.js";
import { expectTransfersRecomputed } from "./testing/transfers-oracle.js";

interface Batch {
  readonly device: string;
  readonly events: ReturnType<typeof toWire>[];
}

/** The script's envelopes in a seeded order with two duplicates, cut into one-device batches. */
function batchesOf(events: RefEvent[], seed: number): Batch[] {
  const envs = toEnvelopes(events, new Names(), syntheticDet(events));
  const order = shuffled(envs, seed);
  const withDupes = [...order, ...shuffled(order, seed + 99).slice(0, 2)];
  const batches: Batch[] = [];
  for (const chunk of chunked(withDupes, seed + 7, 4)) {
    let run: TestEnvelope[] = [];
    const flush = () => {
      if (run.length > 0)
        batches.push({ device: run[0]?.device as string, events: run.map((e) => toWire(e)) });
      run = [];
    };
    for (const e of chunk) {
      if (run.length > 0 && run[0]?.device !== e.device) flush();
      run.push(e);
    }
    flush();
  }
  return batches;
}

/** Every table a deriver owns that the view hash leaves out, as rows. */
function companionTables(store: Store): unknown {
  return {
    months: monthTables(store),
    recurring: recurringState(store),
    search: searchIndex(store),
  };
}

const groupedEqualsSequential = (script: typeof categoryScript) =>
  fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
    const batches = batchesOf(events, seed);
    const one = openTestStore();
    for (const b of batches) one.applyWireBatches([b]);
    const grouped = openTestStore();
    const r = rng(seed + 13);
    for (let i = 0; i < batches.length; ) {
      const n = 1 + Math.floor(r() * 5);
      grouped.applyWireBatches(batches.slice(i, i + n));
      expect(grouped.rederive().touchedTables).toEqual(new Set());
      i += n;
    }
    expect(viewHash(grouped).hash).toBe(viewHash(one).hash);
    expect(companionTables(grouped)).toEqual(companionTables(one));
    expectCategoriesRecomputed(grouped);
    expectTransfersRecomputed(grouped);
    expectMonthsRecomputed(grouped);
    expectRecurringRecomputed(grouped);
    expectSearchIndexed(grouped);
  });

describe("property: several batches in one apply derive what one apply per batch derives", () => {
  it.each([0, 1, 2])("categories script: seed %i", (i) => {
    fc.assert(groupedEqualsSequential(categories), { numRuns: 6, seed: 97_000 + i });
  });

  it.each([0, 1, 2])("recurring script: seed %i", (i) => {
    fc.assert(groupedEqualsSequential(recurringScript), { numRuns: 6, seed: 98_000 + i });
  });

  it.each([0, 1])("transfers script: seed %i", (i) => {
    fc.assert(groupedEqualsSequential(transferScript), { numRuns: 6, seed: 99_000 + i });
  });
});

// Property (the phone's sink cutting one large frame group into several transactions): calls with
// `deriveLater` owe their derivation to the next call that derives, which then derives exactly what one
// call per batch derives. A kill after an owing call (the store opened again on the same database, no
// close) derives the owed partitions at open; the engine then re-delivers the run (duplicates).
const deferredEqualsSequential = (script: typeof categoryScript) =>
  fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
    const batches = batchesOf(events, seed);
    const one = openTestStore();
    for (const b of batches) one.applyWireBatches([b]);
    let deferred = openTestStore();
    const r = rng(seed + 17);
    let notified = 0;
    const listen = (store: Store) =>
      store.subscribe(
        store.publicTables().map((t) => t.name),
        () => {
          notified += 1;
        },
      );
    listen(deferred);
    for (let i = 0; i < batches.length; ) {
      // One run = one engine call cut into parts: every part but the last owes its derivation.
      const run = batches.slice(i, i + 1 + Math.floor(r() * 6));
      for (const [k, b] of run.entries()) {
        const last = k === run.length - 1;
        const before = notified;
        deferred.applyWireBatches([b], { deriveLater: !last });
        if (!last) {
          expect(notified).toBe(before);
          if (r() < 0.25) {
            // Killed here: the next open derives what was owed, then the run comes again.
            deferred = openTestStore({ driver: deferred.driver });
            listen(deferred);
            expect(deferred.rederive().touchedTables).toEqual(new Set());
            for (const again of run.slice(0, k + 1)) deferred.applyWireBatches([again]);
          }
        }
      }
      expect(deferred.rederive().touchedTables).toEqual(new Set());
      i += run.length;
    }
    expect(viewHash(deferred).hash).toBe(viewHash(one).hash);
    expect(companionTables(deferred)).toEqual(companionTables(one));
    expectCategoriesRecomputed(deferred);
    expectTransfersRecomputed(deferred);
    expectMonthsRecomputed(deferred);
    expectRecurringRecomputed(deferred);
    expectSearchIndexed(deferred);
  });

describe("property: parts that owe their derivation to the last part derive what one apply per batch derives", () => {
  it.each([0, 1, 2])("categories script: seed %i", (i) => {
    fc.assert(deferredEqualsSequential(categories), { numRuns: 6, seed: 97_100 + i });
  });

  it.each([0, 1, 2])("recurring script: seed %i", (i) => {
    fc.assert(deferredEqualsSequential(recurringScript), { numRuns: 6, seed: 98_100 + i });
  });

  it.each([0, 1])("transfers script: seed %i", (i) => {
    fc.assert(deferredEqualsSequential(transferScript), { numRuns: 6, seed: 99_100 + i });
  });
});

it("an owing apply leaves the derived tables behind until the next apply derives them", () => {
  // The first sampled script whose derived tables are not empty (the oracle's own check).
  const empty = companionTables(openTestStore());
  const sampled = fc
    .sample(recurringScript, { numRuns: 50, seed: 4242 })
    .map((events) => {
      const batches = batchesOf(events, 4242);
      const one = openTestStore();
      for (const b of batches) one.applyWireBatches([b]);
      return { batches, one };
    })
    .find(({ one }) => JSON.stringify(companionTables(one)) !== JSON.stringify(empty));
  if (sampled === undefined) throw new Error("no script with derived rows");
  const { batches, one } = sampled;
  const store = openTestStore();
  for (const b of batches) store.applyWireBatches([b], { deriveLater: true });
  // The folded view is there, the derived tables are not yet.
  expect(companionTables(store)).not.toEqual(companionTables(one));
  // An empty deriving apply settles what every owing apply left.
  store.applyWireBatches([]);
  expect(viewHash(store).hash).toBe(viewHash(one).hash);
  expect(companionTables(store)).toEqual(companionTables(one));
  expect(store.rederive().touchedTables).toEqual(new Set());
});
