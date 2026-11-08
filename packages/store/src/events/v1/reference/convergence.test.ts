// Convergence of the reference fold on every shared scenario (reference/testing/scenarios.ts): each
// scenario is delivered in many shuffled orders with re-delivered duplicates; every prefix keeps the
// invariants and every full delivery yields the same view, which has the expected shape.
import { describe, expect, it } from "vitest";
import {
  materialize,
  type RefDet,
  type RefEvent,
  type RefView,
} from "../../../testing/reference/fold.js";
import { delivery, ORDERS, SCENARIOS, syntheticDet } from "./testing/scenarios.js";

function invariants(v: RefView): void {
  const open = new Map<string, number>();
  for (const ep of Object.values(v.signals)) {
    if (ep.status === "active" || ep.status === "acknowledged") {
      open.set(ep.key, (open.get(ep.key) ?? 0) + 1);
    }
  }
  for (const [key, n] of open) expect(n, `open episodes for ${key}`).toBe(1);
}

/** Deliver `events` in ORDERS shuffles (+ duplicates); check prefixes; return the common view. */
function converge(events: readonly RefEvent[], det: RefDet): RefView {
  const reference = materialize(events, det);
  invariants(reference);
  for (let k = 0; k < ORDERS; k++) {
    const withDupes = delivery(events, k);
    for (let i = 1; i <= withDupes.length; i++) invariants(materialize(withDupes.slice(0, i), det));
    expect(materialize(withDupes, det)).toEqual(reference);
  }
  return reference;
}

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it(s.name, () => s.check(converge(s.events, syntheticDet(s.events))));
  });
}

describe("syntheticDet", () => {
  const e = (gid: string, dedupHash: string): RefEvent => ({
    eid: `01JC${gid}${dedupHash}`.padEnd(26, "0"),
    hlc: "0mvwcmtc0-0000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    at: "2026-10-31T12:00:00.000Z",
    type: "txn.imported",
    gid,
    data: { account: "A", dedupHash, occurrence: 0 },
  });

  it("binds a row key to the gid its first declared event names", () => {
    const det = syntheticDet([e("t1", "h1"), e("t2", "h2")]);
    expect(det("transactions", ["A", "h1", "0"])).toBe("t1");
    expect(det("transactions", ["A", "h2", "0"])).toBe("t2");
  });

  it("makes a second row key for one gid invalid (G1 shape)", () => {
    const det = syntheticDet([e("t1", "h1"), e("t1", "h2")]);
    expect(det("transactions", ["A", "h1", "0"])).toBe("t1");
    expect(det("transactions", ["A", "h2", "0"])).not.toBe("t1");
  });

  it("makes a second gid for one row key invalid (G2 shape)", () => {
    const det = syntheticDet([e("t1", "h1"), e("t2", "h1")]);
    expect(det("transactions", ["A", "h1", "0"])).toBe("t1");
  });
});
