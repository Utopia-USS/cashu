// Signals completion (S25 spec 4.8: F1-F3, the public alias table, version 2; scenario SG1). The
// episode rules themselves are covered by the shared convergence scenarios. Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, converge, DEV_B, Events, instrument, row, rows, ulid } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";
const RUN1 = ulid(101);
const RUN2 = ulid(102);

describe("inv_signals: refresh fields, run register, payload keys (S25-F1..F3)", () => {
  it("a refresh rewrites rule / kind / polarity / instrument / account and sets last_run_id (null clears)", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["xtb", "SIG"]);
    const S = ulid(1);
    store.applyEnvelopes([
      account(ev, ACC),
      ...i.events,
      ev.make("signal.opened", S, { dedupKey: "research:2026-w44|t:x", run: RUN1 }),
    ]);
    expect(row(store, "inv_signals", S)).toMatchObject({ created_run_id: RUN1, last_run_id: RUN1 });
    store.applyEnvelopes([
      ev.make("signal.refreshed", S, {
        run: RUN2,
        seenAt: "2026-11-01T00:00:00.000Z",
        ruleId: "research:2026-w44",
        kind: "research",
        polarity: "positive",
        instrument: i.gid,
        account: ACC,
      }),
    ]);
    expect(row(store, "inv_signals", S)).toMatchObject({
      rule_id: "research:2026-w44",
      kind: "research",
      polarity: "positive",
      instrument_id: i.gid,
      account_id: ACC,
      last_run_id: RUN2,
      created_run_id: RUN1,
      last_seen_at: "2026-11-01 00:00:00.000000",
    });
    store.applyEnvelopes([
      ev.make("signal.refreshed", S, { run: null, seenAt: "2026-11-02T00:00:00.000Z" }),
    ]);
    expect(row(store, "inv_signals", S)).toMatchObject({
      last_run_id: null, // F2: the research sync refreshes without a run
      kind: "research", // absent = keep
      instrument_id: i.gid,
    });
  });

  it("a close merges payloadSet and sets the run when present; a reopen removes payloadUnset", () => {
    const store = openTestStore();
    const ev = new Events();
    const S = ulid(2);
    store.applyEnvelopes([
      ev.make("signal.opened", S, { dedupKey: "research:w|t:y", payload: { a: 1 }, run: RUN1 }),
      ev.make("signal.closed", S, {
        status: "resolved",
        reason: "note_dismissed",
        payloadSet: { closed_reason: "note_dismissed", previous_status: "active" },
      }),
    ]);
    expect(row(store, "inv_signals", S)).toMatchObject({
      status: "resolved",
      last_run_id: RUN1, // no run on the close: kept
      payload: { a: 1, closed_reason: "note_dismissed", previous_status: "active" },
    });
    store.applyEnvelopes([
      ev.make("signal.reopened", S, {
        reason: "note_restored",
        payloadUnset: ["closed_reason", "previous_status"],
      }),
      ev.make("signal.closed", S, { status: "expired", reason: "stale", run: null }),
    ]);
    expect(row(store, "inv_signals", S)).toMatchObject({
      status: "expired",
      last_run_id: null,
      payload: { a: 1 },
    });
  });

  it("the alias path of an open is a refresh: its fields and run replace the episode's", () => {
    const store = openTestStore();
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const S1 = ulid(3);
    const S2 = ulid(4);
    store.applyEnvelopes([
      a.make("signal.opened", S1, { dedupKey: "k", kind: "k1", run: RUN1 }, { wall: 1 }),
      b.make(
        "signal.opened",
        S2,
        { dedupKey: "k", kind: "k2", polarity: "negative", run: null },
        {
          wall: 2,
        },
      ),
    ]);
    expect(rows(store, "inv_signals")).toEqual([
      expect.objectContaining({ gid: S1, kind: "k2", polarity: "negative", last_run_id: null }),
    ]);
  });

  it("publishes every signal gid -> its episode row in inv_signal_aliases (D-S2)", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const S1 = ulid(5);
    const S2 = ulid(6);
    const events = [
      a.make("signal.opened", S1, { dedupKey: "dd|x" }, { wall: 1 }),
      b.make("signal.opened", S2, { dedupKey: "dd|x" }, { wall: 2 }),
    ];
    converge(events, (store) => {
      expect(rows(store, "inv_signal_aliases")).toEqual(
        [
          { gid: S1, signal_id: S1 },
          { gid: S2, signal_id: S1 },
        ].sort((x, y) => (x.gid < y.gid ? -1 : 1)),
      );
    });
  });

  it("SG1: refresh with run null after a run-linked refresh, close with payloadSet, reopen with unset", () => {
    const ev = new Events();
    const S = ulid(7);
    const events = [
      ev.make("alert.created", ulid(8), {}, { wall: 1 }),
      ev.make("signal.opened", S, { dedupKey: `alert:${ulid(8)}`, run: RUN1 }, { wall: 2 }),
      ev.make("signal.refreshed", S, { run: RUN2, seenAt: "2026-11-01T00:00:00Z" }, { wall: 3 }),
      ev.make("signal.refreshed", S, { run: null, seenAt: "2026-11-02T00:00:00Z" }, { wall: 4 }),
      ev.make("alert.deleted", ulid(8), {}, { wall: 5 }),
      ev.make(
        "signal.closed",
        S,
        { status: "expired", reason: "delete", payloadSet: { closed_by: "delete" } },
        { wall: 6 },
      ),
      ev.make("alert.restored", ulid(8), {}, { wall: 7 }),
      ev.make(
        "signal.reopened",
        S,
        { reason: "alert_restored", payloadUnset: ["closed_by"] },
        { wall: 8 },
      ),
    ];
    converge(events, (store) => {
      expect(row(store, "inv_signals", S)).toMatchObject({
        status: "active",
        last_run_id: null,
        created_run_id: RUN1,
        payload: {},
        closed_at: null,
      });
      expect(row(store, "alerts", ulid(8))).toMatchObject({ deleted_at: null, status: "active" });
    });
  });
});
