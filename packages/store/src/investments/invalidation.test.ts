// Touched-table invalidation for the investments tables (data-flow.md "Invalidation is by tables"):
// an apply reports exactly the public tables it wrote, a late event re-folds only its materializer's
// tables, and subscribers of a table hear about it. Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, claim, DEV_B, det, Events, instrument, ulid } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";

describe("investments touched tables", () => {
  it("each event type reports exactly the public tables its materializer wrote", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["xtb", "INV"]);
    store.applyEnvelopes([account(ev, ACC), ...i.events]);
    const touched = (e: ReturnType<Events["make"]>) =>
      [...store.applyEnvelopes([e]).touchedTables].sort();
    expect(touched(ev.make("ruleRun.finished", ulid(1)))).toEqual(["inv_rule_runs"]);
    expect(
      touched(
        ev.make(
          "instrumentRename.recorded",
          det("inv_instrument_renames", "2026-02-01", i.gid, ulid(2)),
          {
            date: "2026-02-01",
            old: i.gid,
            new: ulid(2),
          },
        ),
      ),
    ).toEqual(["inv_instrument_renames"]);
    expect(touched(ev.make("review.done", ulid(3)))).toEqual(["reviews"]);
    expect(touched(ev.make("review.undone", ulid(3)))).toEqual(["reviews"]);
    expect(touched(ev.make("instrument.updated", i.gid, { sector: "banki" }))).toEqual([
      "inv_instruments",
    ]);
    // an event whose row is not held (yet) touches nothing
    expect(touched(ev.make("note.read", ulid(4)))).toEqual([]);
  });

  it("a late event re-folds its partition and reports only that materializer's tables", () => {
    const store = openTestStore();
    const ev = new Events();
    const late = new Events(DEV_B, "01JB");
    const TH = ulid(10);
    store.applyEnvelopes([
      ev.make("thesis.created", TH, { instrument: ulid(11) }, { wall: 10 }),
      ev.make("alert.created", ulid(12), {}, { wall: 11 }),
    ]);
    // sorts before the create already applied: partition re-fold of the thesis
    const r = store.applyEnvelopes([late.make("thesis.updated", TH, { thesis: "x" }, { wall: 5 })]);
    expect([...r.touchedTables]).toEqual(["inv_theses"]);
  });

  it("notifies subscribers of an investments table, and an alias collision re-folds instrument rows", () => {
    const store = openTestStore();
    const ev = new Events();
    const seen: string[][] = [];
    const off = store.subscribe(["inv_instruments"], (t) => seen.push([...t].sort()));
    const a = instrument(ev, ["xtb", "A1"], {}, { wall: 1 });
    const b = instrument(ev, ["xtb", "B1"], {}, { wall: 2 });
    store.applyEnvelopes([...a.events, ...b.events]);
    expect(seen).toEqual([["inv_instrument_aliases", "inv_instruments"]]);
    const r = store.applyEnvelopes([claim(ev, b.gid, ["xtb", "A1"], { wall: 3 })]);
    expect([...r.touchedTables]).toEqual(expect.arrayContaining(["inv_instruments"]));
    expect(seen).toHaveLength(2);
    off();
  });
});
