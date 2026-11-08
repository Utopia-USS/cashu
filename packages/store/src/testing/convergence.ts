// The convergence driver of the shared conflict-rule scenarios (testing/scenarios.ts): the store
// folds each scenario to one view on every delivery order. Used by convergence.test.ts (a few
// orders, fast tier) and convergence.exhaustive.test.ts (every order). Synthetic names stand for
// gids; `toEnvelopes` maps them to valid gids and `project` maps the store's view back to the
// scenarios' readable shape.
import { expect } from "vitest";
import type { Store } from "../materialize.js";
import { viewHash } from "../snapshot.js";
import { expectCategoriesRecomputed } from "./categories-oracle.js";
import { chunked } from "./random.js";
import { Names, project, type RefDet, type RefEvent, toEnvelopes } from "./scenario-bridge.js";
import { delivery } from "./scenarios.js";
import { openTestStore } from "./store.js";

function openInvariant(store: Store): void {
  const dup = store.read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT dedup_key FROM inv_signals WHERE status IN ('active','acknowledged') GROUP BY dedup_key HAVING COUNT(*) > 1)",
  )[0];
  expect(dup?.n).toBe(0);
}

/**
 * Deliver the scenario in each of `orders` (delivery k: single events for even k, random batches
 * for odd k, plus re-delivered duplicates); after every batch check the open-episode invariant and
 * the derived oracle (re-deriving everything changes nothing); every order must project to one view
 * with one view hash, the effective categories must equal the domain recompute, and a rebuild must
 * keep that hash. Returns the projected view for the scenario's checks.
 */
export function converge(events: readonly RefEvent[], det: RefDet, orders: readonly number[]) {
  let hash: string | undefined;
  let view: ReturnType<typeof project> | undefined;
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
    if (view === undefined) view = projected;
    else expect(projected).toEqual(view);
    expectCategoriesRecomputed(store);
    const h = viewHash(store).hash;
    hash ??= h;
    expect(h).toBe(hash);
    store.rebuild();
    expect(viewHash(store).hash).toBe(hash);
  }
  if (view === undefined) throw new Error("converge needs at least one order");
  return view;
}
