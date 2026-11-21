import { formatHlc } from "@cashu/sync/hlc";
import { describe, expect, it } from "vitest";
import type { Read } from "../../core/queries.js";
import { openTestStore } from "../../testing/store.js";
import { decisions, theses } from "../queries/journal.js";
import { reviews } from "../queries/reviews.js";
import { ruleRuns } from "../queries/signals.js";
import { latestRun } from "../research/queries.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { household } from "../testing/household.js";
import { DEV_A, DEV_B, ulid } from "../testing/kit.js";
import { byCreation, compareReadRank, creationRanks } from "./stableOrder.js";

const AT = "2026-10-31T12:00:00.123456Z";
const stamp = (column: string) => ({ [column]: AT });
describe("public-row applied creation anchors", () => {
  it("ignores suppressed and parked earlier creations of a still-visible entity", () => {
    const h = household();
    const id = ulid(720);
    const proposal = ulid(721);
    const approved = h.ev.make("proposal.approved", proposal, { result: {} }, { wall: 90 });
    const data = {
      instrument: h.first,
      stamps: { ...stamp("created_at"), ...stamp("updated_at"), ...stamp("core_changed_at") },
    };
    const suppressed = h.ev.make("thesis.created", id, data, { wall: 100, cause: approved.eid });
    // A future schema version is parked; an unknown cause is legitimately suppressed instead.
    const parked = { ...h.ev.make("thesis.created", id, data, { wall: 50 }), v: 99 };
    const applied = h.ev.make("thesis.created", id, data, { wall: 300 });
    const events = [
      ...h.events,
      h.ev.make(
        "proposal.created",
        proposal,
        { kind: "strategy", summary: "Synthetic", reason: null, payload: {}, source: "mcp" },
        { wall: 80 },
      ),
      approved,
      suppressed,
      parked,
      applied,
      h.ev.make(
        "proposal.applyFailed",
        proposal,
        { result: { error_code: "synthetic" }, approval: approved.eid },
        { wall: 200 },
      ),
    ];
    assertOrderedDelivery(events, (store) => {
      expect(
        store.read<{ state: string }>("SELECT state FROM event_log WHERE eid=?", suppressed.eid)[0]
          ?.state,
      ).toBe("suppressed");
      expect(
        store.read<{ state: string }>("SELECT state FROM event_log WHERE eid=?", parked.eid)[0]
          ?.state,
      ).toBe("parked");
      const anchor = creationRanks(store.read.bind(store), "theses").get(id);
      expect(anchor).toEqual({ gid: id, hlc: applied.hlc, eid: applied.eid });
      return { anchor, rows: theses(store.read.bind(store)) };
    });
  });

  it("SQL and the existing HLC comparator agree across counter, actor, and eid ties", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const ids = [ulid(801), ulid(802), ulid(803), ulid(804)];
    const events = [
      h.ev.make(
        "thesis.created",
        ids[0] as string,
        { instrument: h.first, stamps: stamp("created_at") },
        { wall: 500, counter: 9, device: DEV_A },
      ),
      h.ev.make(
        "thesis.created",
        ids[1] as string,
        { instrument: h.first, stamps: stamp("created_at") },
        { wall: 500, counter: 10, device: DEV_A },
      ),
      h.ev.make(
        "thesis.created",
        ids[2] as string,
        { instrument: h.first, stamps: stamp("created_at") },
        { wall: 500, counter: 10, device: DEV_B },
      ),
      h.ev.make(
        "thesis.created",
        ids[3] as string,
        { instrument: h.first, stamps: stamp("created_at") },
        { wall: 500, counter: 10, device: DEV_B },
      ),
    ];
    store.applyEnvelopes([...events].reverse());
    const ranks = [...creationRanks(store.read.bind(store), "theses").values()];
    const expected = [...ranks].sort(compareReadRank).map((row) => row.gid);
    const sql = store
      .read<{ gid: string }>(
        `SELECT t.gid FROM inv_theses t JOIN event_log e ON e.gid=t.gid WHERE e.type='thesis.created' AND e.state='applied' ORDER BY e.hlc COLLATE BINARY, e.eid COLLATE BINARY`,
      )
      .map((row) => row.gid);
    expect(sql).toEqual(expected);
    expect(expected).toEqual(ids);
    expect(
      formatHlc({ wall: 500, counter: 9, device: DEV_A }) <
        formatHlc({ wall: 500, counter: 10, device: DEV_A }),
    ).toBe(true);
    store.close();
  });

  it("newest thesis and current runs use their original append, even after an edit or finish", () => {
    const h = household();
    const low = ulid(601);
    const high = ulid(602);
    const events = [
      ...h.events,
      h.ev.make(
        "thesis.created",
        high,
        { instrument: h.first, thesis: "Older", stamps: stamp("created_at") },
        { wall: 100 },
      ),
      h.ev.make(
        "thesis.created",
        low,
        { instrument: h.first, thesis: "Newer", stamps: stamp("created_at") },
        { wall: 101 },
      ),
      h.ev.make("thesis.updated", high, { thesis: "Edited older" }, { wall: 200 }),
      h.ev.make("ruleRun.finished", high, { stamps: stamp("started_at") }, { wall: 100 }),
      h.ev.make("ruleRun.finished", low, { stamps: stamp("started_at") }, { wall: 101 }),
      h.ev.make(
        "researchRun.started",
        high,
        { scope: {}, createdBy: "agent", stamps: stamp("started_at") },
        { wall: 100 },
      ),
      h.ev.make(
        "researchRun.started",
        low,
        { scope: {}, createdBy: "agent", stamps: stamp("started_at") },
        { wall: 101 },
      ),
      h.ev.make("researchRun.finished", high, { status: "done", counts: {} }, { wall: 300 }),
      h.ev.make("review.done", high, { stamps: stamp("done_at") }, { wall: 100 }),
      h.ev.make("review.done", low, { stamps: stamp("done_at") }, { wall: 101 }),
    ];
    const projected = assertOrderedDelivery(events, (store) => ({
      theses: theses(store.read.bind(store)).map((row) => row.gid),
      runs: ruleRuns(store.read.bind(store), 1).map((row) => row.gid),
      research: latestRun(store.read.bind(store))?.gid,
      reviews: reviews(store.read.bind(store), "investments").map((row) => row.gid),
    }));
    expect(projected).toEqual({
      theses: [low, high],
      runs: [low],
      research: low,
      reviews: [low, high],
    });
  });

  it("a late earlier ignored create updates rank and invalidates despite identical public row contents", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const id = ulid(710);
    const data = {
      instrument: h.first,
      stamps: { ...stamp("created_at"), ...stamp("updated_at"), ...stamp("core_changed_at") },
    };
    store.applyEnvelopes([h.ev.make("thesis.created", id, data, { wall: 300 })]);
    const before = theses(store.read.bind(store));
    const previous = creationRanks(store.read.bind(store), "theses").get(id);
    const reads = new Set<string>();
    const read: Read = (sql, ...params) => {
      for (const table of store.tablesRead(sql)) reads.add(table);
      return store.read(sql, ...params);
    };
    creationRanks(read, "theses");
    expect(reads.has("inv_theses")).toBe(true);
    let notifications = 0;
    const off = store.subscribe(reads, () => {
      notifications++;
    });
    store.applyEnvelopes([h.ev.make("thesis.created", id, data, { wall: 200 })]);
    expect(theses(store.read.bind(store))).toEqual(before);
    expect(creationRanks(store.read.bind(store), "theses").get(id)?.hlc).not.toBe(previous?.hlc);
    expect(notifications).toBe(1);
    off();
    store.close();
  });

  it("decision and import APPEND anchors retain original creation; missing anchors fail closed", () => {
    const h = household();
    const one = ulid(901);
    const two = ulid(902);
    const data = {
      signals: [],
      instrument: h.first,
      account: h.accountA,
      action: "held",
      quantity: null,
      price: null,
      currency: null,
      reason: null,
      stamps: stamp("created_at"),
    };
    const events = [
      ...h.events,
      h.ev.make("decision.recorded", two, data, { wall: 200 }),
      h.ev.make("decision.recorded", one, data, { wall: 201 }),
      h.ev.make("decision.recorded", two, { ...data, reason: "Ignored repeat" }, { wall: 400 }),
      h.ev.make("invImport.recorded", two, { account: h.accountA }, { wall: 200 }),
      h.ev.make("invImport.recorded", one, { account: h.accountA }, { wall: 201 }),
      h.ev.make(
        "invImport.recorded",
        two,
        { account: h.accountA, fileName: "ignored.csv" },
        { wall: 400 },
      ),
    ];
    const result = assertOrderedDelivery(events, (store) => ({
      decisions: decisions(store.read.bind(store)).map((row) => row.gid),
      imports: byCreation(
        store.read.bind(store),
        "imports",
        [{ gid: one }, { gid: two }],
        true,
      ).map((row) => row.gid),
    }));
    expect(result).toEqual({ decisions: [one, two], imports: [one, two] });
    const syntheticRead: Read = () => [{ gid: one, hlc: null, eid: null }] as never;
    expect(() => creationRanks(syntheticRead, "theses")).toThrow(
      "missing its applied creation anchor",
    );
  });
});
