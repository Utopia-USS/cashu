// Position snapshots and instrument renames (S25 spec 4.5; scenario I3). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, claim, converge, DEV_B, det, Events, instrument, rows } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";

describe("inv_position_snapshots", () => {
  it("creates one row per (account, instrument, asOf)", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["xtb", "AAA"]);
    store.applyEnvelopes([account(ev, ACC), ...i.events]);
    const g = det("inv_position_snapshots", ACC, i.gid, "2026-03-31");
    const r = store.applyEnvelopes([
      ev.make("position.snapshotImported", g, {
        account: ACC,
        instrument: i.gid,
        asOf: "2026-03-31",
        marketValue: "130.00",
      }),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_position_snapshots"]);
    expect(rows(store, "inv_position_snapshots")).toEqual([
      expect.objectContaining({
        gid: g,
        account_id: ACC,
        instrument_id: i.gid,
        as_of: "2026-03-31",
        quantity: "10",
        market_value: "130.00",
        avg_price: null,
      }),
    ]);
  });

  it("I3: snapshots under two instrument gids that later merge keep the first applied", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const ia = instrument(a, ["xtb", "AAA"], {}, { wall: 1 });
    const ib = instrument(b, ["stooq", "aaa"], {}, { wall: 2 });
    const events = [
      account(a, ACC, [], { wall: 0 }),
      ...ia.events,
      ...ib.events,
      a.make(
        "position.snapshotImported",
        det("inv_position_snapshots", ACC, ia.gid, "2026-03-31"),
        {
          account: ACC,
          instrument: ia.gid,
          asOf: "2026-03-31",
          quantity: "1",
        },
        { wall: 10 },
      ),
      b.make(
        "position.snapshotImported",
        det("inv_position_snapshots", ACC, ib.gid, "2026-03-31"),
        {
          account: ACC,
          instrument: ib.gid,
          asOf: "2026-03-31",
          quantity: "2",
        },
        { wall: 11 },
      ),
      claim(b, ib.gid, ["xtb", "AAA"], { wall: 20 }), // b's instrument joins a's
    ];
    converge(events, (store) => {
      expect(
        rows(store, "inv_position_snapshots").map((r) => [r.instrument_id, r.quantity]),
      ).toEqual([[ia.gid, "1"]]);
    });
  });
});

describe("inv_instrument_renames", () => {
  it("shows a rename until both ends resolve to one instrument", () => {
    const ev = new Events();
    const o = instrument(ev, ["xtb", "OLD"], {}, { wall: 1 });
    const n = instrument(ev, ["xtb", "NEW"], {}, { wall: 2 });
    const rename = ev.make(
      "instrumentRename.recorded",
      det("inv_instrument_renames", "2026-02-01", o.gid, n.gid),
      { date: "2026-02-01", old: o.gid, new: n.gid },
      { wall: 3 },
    );
    const store = openTestStore();
    store.applyEnvelopes([...o.events, ...n.events, rename]);
    expect(rows(store, "inv_instrument_renames")).toEqual([
      expect.objectContaining({
        date: "2026-02-01",
        old_instrument_id: o.gid,
        new_instrument_id: n.gid,
      }),
    ]);
    const merged = ev.make(
      "instrument.merged",
      o.gid,
      { source: o.gid, target: n.gid, reason: "owner" },
      { wall: 4 },
    );
    converge([...o.events, ...n.events, rename, merged], (s) => {
      expect(rows(s, "inv_instrument_renames")).toEqual([]);
    });
  });
});
