// Acceptance: the production store agrees with the executable reference fold
// (`events/v1/reference/fold.ts`) on every shared scenario (`reference/testing/scenarios.ts`), and
// converges itself: every shuffled delivery (single events and random batches, with re-delivered
// duplicates) gives the same view hash, and a rebuild from the log gives that hash too. Synthetic
// names stand for gids; `toEnvelopes` maps them to valid gids and `project` maps the store's view
// back to the reference's shape.
import { describe, expect, it } from "vitest";
import {
  materialize,
  type RefDet,
  type RefEvent,
  type RefView,
} from "./events/v1/reference/fold.js";
import {
  delivery,
  ORDERS,
  SCENARIOS,
  syntheticDet,
} from "./events/v1/reference/testing/scenarios.js";
import type { Store } from "./materialize.js";
import { viewHash } from "./snapshot.js";
import { chunked } from "./testing/random.js";
import { Names, normalize, project, toEnvelopes } from "./testing/reference-bridge.js";
import { openTestStore } from "./testing/store.js";

function openInvariant(store: Store): void {
  const dup = store.read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT dedup_key FROM inv_signals WHERE status IN ('active','acknowledged') GROUP BY dedup_key HAVING COUNT(*) > 1)",
  )[0];
  expect(dup?.n).toBe(0);
}

/**
 * Deliver the scenario in ORDERS shuffles (single events for even k, random batches for odd k) plus
 * re-delivered duplicates; check the invariant after every batch; return the projected view.
 */
function converge(events: readonly RefEvent[], det: RefDet): RefView {
  const expected = normalize(materialize(events, det));
  let hash: string | undefined;
  let view: RefView | undefined;
  for (let k = 0; k < ORDERS; k++) {
    const names = new Names();
    const withDupes = delivery(toEnvelopes(events, names, det), k);
    const store = openTestStore();
    const batches = k % 2 === 0 ? withDupes.map((e) => [e]) : chunked(withDupes, k + 7);
    for (const b of batches) {
      store.applyEnvelopes(b);
      openInvariant(store);
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
  return view as RefView;
}

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it(`production fold = reference fold: ${s.name}`, () =>
      s.check(converge(s.events, syntheticDet(s.events))));
  });
}
