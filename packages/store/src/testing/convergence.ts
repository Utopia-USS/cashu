// The convergence driver of the shared scenarios (reference/testing/scenarios.ts): the production
// store agrees with the executable reference fold and converges itself on every delivery order.
// Used by convergence.test.ts (a few orders, fast tier) and convergence.exhaustive.test.ts (every
// order). Synthetic names stand for gids; `toEnvelopes` maps them to valid gids and `project` maps
// the store's view back to the reference's shape.
import { expect } from "vitest";
import { materialize, type RefDet, type RefEvent } from "../events/v1/reference/fold.js";
import { delivery } from "../events/v1/reference/testing/scenarios.js";
import type { Store } from "../materialize.js";
import { viewHash } from "../snapshot.js";
import { chunked } from "./random.js";
import { Names, normalize, project, toEnvelopes } from "./reference-bridge.js";
import { openTestStore } from "./store.js";

function openInvariant(store: Store): void {
  const dup = store.read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT dedup_key FROM inv_signals WHERE status IN ('active','acknowledged') GROUP BY dedup_key HAVING COUNT(*) > 1)",
  )[0];
  expect(dup?.n).toBe(0);
}

/**
 * Deliver the scenario in each of `orders` (delivery k: single events for even k, random batches
 * for odd k, plus re-delivered duplicates); after every batch check the invariant and the derived
 * oracle (re-deriving everything changes nothing, S24 6); every order must project to the reference
 * view with one view hash, and a rebuild must keep that hash. Returns the projected view.
 */
export function converge(events: readonly RefEvent[], det: RefDet, orders: readonly number[]) {
  const expected = normalize(materialize(events, det));
  let hash: string | undefined;
  let view = expected;
  for (const k of orders) {
    const names = new Names();
    const withDupes = delivery(toEnvelopes(events, names, det), k);
    const store = openTestStore();
    const batches = k % 2 === 0 ? withDupes.map((e) => [e]) : chunked(withDupes, k + 7);
    for (const b of batches) {
      store.applyEnvelopes(b);
      openInvariant(store);
      expect(store.rederive().touchedTables).toEqual(new Set());
    }
    const projected = project(store, names);
    expect(projected).toEqual(expected);
    const h = viewHash(store).hash;
    if (hash === undefined) hash = h;
    expect(h).toBe(hash);
    store.rebuild();
    expect(viewHash(store).hash).toBe(hash);
    view = projected;
  }
  return view;
}
