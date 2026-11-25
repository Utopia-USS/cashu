/** Assert actual ordered service DTOs across shuffled delivery, duplicates, and a full rebuild. */
import { expect } from "vitest";
import type { Store } from "../../materialize.js";
import { chunked, shuffled } from "../../testing/random.js";
import { openTestStore, type TestEnvelope } from "../../testing/store.js";

export function assertOrderedDelivery<T>(
  events: readonly TestEnvelope[],
  project: (store: Store) => T,
): T {
  let expected: T | undefined;
  for (const seed of [1, 9, 31]) {
    const store = openTestStore();
    try {
      const order = shuffled(events, seed);
      for (const batch of chunked([...order, ...order.slice(0, 5)], seed + 2)) {
        expect(store.applyEnvelopes(batch).rejected).toEqual([]);
      }
      const actual = project(store);
      expected ??= actual;
      expect(actual).toEqual(expected);
      store.rebuild();
      expect(project(store)).toEqual(expected);
    } finally {
      store.close();
    }
  }
  if (expected === undefined) throw new Error("ordered delivery did not project a result");
  return expected;
}
