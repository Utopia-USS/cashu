// Research runs and notes, reviews (S25 spec 4.14-4.16; scenarios N1, N2). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { claim, converge, DEV_B, det, Events, instrument, row, rows, ulid } from "./testing/kit.js";

const RUN = ulid(1);
const N = ulid(2);

describe("research_runs", () => {
  it("starts running and finishes with status, counts and finished_at", () => {
    const store = openTestStore();
    const ev = new Events();
    const r = store.applyEnvelopes([
      ev.make("researchRun.started", RUN, { scope: { segments: ["gold"] } }, { wall: 10 }),
    ]);
    expect([...r.touchedTables]).toEqual(["research_runs"]);
    expect(row(store, "research_runs", RUN)).toEqual({
      gid: RUN,
      started_at: "2026-10-31 12:00:00.010000",
      finished_at: null,
      status: "running",
      scope: { segments: ["gold"] },
      counts: {},
      created_by: "agent",
    });
    store.applyEnvelopes([
      ev.make("researchRun.finished", RUN, { status: "done", counts: { notes: 2 } }, { wall: 20 }),
    ]);
    expect(row(store, "research_runs", RUN)).toMatchObject({
      status: "done",
      counts: { notes: 2 },
      finished_at: "2026-10-31 12:00:00.020000",
    });
  });
});

describe("research_notes", () => {
  it("an agent note is born unread, an owner note born read, a read_at stamp wins", () => {
    const store = openTestStore();
    const ev = new Events();
    const r = store.applyEnvelopes([
      ev.make("note.added", N, { run: RUN }, { wall: 10 }),
      ev.make("note.added", ulid(3), { createdBy: "user" }, { wall: 11 }),
      ev.make(
        "note.added",
        ulid(4),
        { stamps: { read_at: null }, createdBy: "user" },
        { wall: 12 },
      ),
    ]);
    expect([...r.touchedTables]).toEqual(["research_notes"]);
    expect(row(store, "research_notes", N)).toMatchObject({
      run_id: RUN,
      read_at: null,
      kind: "news",
      sources: [{ title: "Zrodlo", url: "https://example.org/z" }],
      observed_at: "2026-03-02 08:00:00.000000",
      expires_at: "2026-04-01 08:00:00.000000",
      created_at: "2026-10-31 12:00:00.010000",
    });
    expect(row(store, "research_notes", ulid(3))?.read_at).toBe("2026-10-31 12:00:00.011000");
    expect(row(store, "research_notes", ulid(4))?.read_at).toBeNull();
  });

  it("N1: dismissed twice, restored, read by two devices: first read wins, dismiss GUARD", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const until = "2027-01-01T00:00:00.000Z";
    const events = [
      a.make("note.added", N, {}, { wall: 10 }),
      a.make("note.dismissed", N, { cooldownUntil: until }, { wall: 20 }),
      b.make("note.dismissed", N, { cooldownUntil: null }, { wall: 21 }), // GUARD: already dismissed
      a.make("note.restored", N, {}, { wall: 30 }),
      b.make("note.restored", N, {}, { wall: 31 }), // GUARD: not dismissed
      a.make("note.read", N, {}, { wall: 40 }),
      b.make("note.read", N, {}, { wall: 41 }),
      a.make("note.dismissed", N, { cooldownUntil: until }, { wall: 50 }),
    ];
    converge(events, (store) => {
      expect(row(store, "research_notes", N)).toMatchObject({
        read_at: "2026-10-31 12:00:00.040000",
        dismissed_at: "2026-10-31 12:00:00.050000",
        cooldown_until: "2027-01-01 00:00:00.000000",
        updated_at: "2026-10-31 12:00:00.050000",
      });
    });
  });

  it("N2: candidate accept (caused watchlist + thesis) and undo end on the note's details", () => {
    const ev = new Events();
    const inst = instrument(ev, ["isin", "PLCAND000001"], {}, { wall: 5 });
    const accept = ev.make(
      "note.candidateUpdated",
      N,
      { instrument: inst.gid, details: { accepted: true } },
      { wall: 20 },
    );
    const events = [
      ...inst.events,
      ev.make(
        "note.added",
        N,
        { kind: "candidate", candidateKey: "PLCAND000001", details: {} },
        {
          wall: 10,
        },
      ),
      accept,
      ev.make(
        "watchlist.added",
        det("watchlist_items", inst.gid),
        { instrument: inst.gid, source: "agent" },
        { wall: 21, cause: accept.eid },
      ),
      ev.make(
        "thesis.created",
        ulid(30),
        { instrument: inst.gid },
        { wall: 22, cause: accept.eid },
      ),
      ev.make("note.candidateUpdated", N, { instrument: null, details: {} }, { wall: 40 }),
    ];
    converge(events, (store) => {
      expect(row(store, "research_notes", N)).toMatchObject({
        instrument_id: null,
        details: {},
        updated_at: "2026-10-31 12:00:00.040000",
      });
      expect(rows(store, "watchlist_items")).toHaveLength(1);
      expect(rows(store, "inv_theses")).toHaveLength(1);
    });
  });

  it("signalLinked re-points signal_id as named without an updated_at change", () => {
    const store = openTestStore();
    const ev = new Events();
    const S = ulid(60);
    store.applyEnvelopes([
      ev.make("note.added", N, {}, { wall: 10 }),
      ev.make("note.signalLinked", N, { signal: S }, { wall: 20 }),
    ]);
    expect(row(store, "research_notes", N)).toMatchObject({
      signal_id: S,
      updated_at: "2026-10-31 12:00:00.010000",
    });
  });

  it("an instrument merge re-points the note's instrument to the root", () => {
    const ev = new Events();
    const x = instrument(ev, ["stooq", "nx"], {}, { wall: 1 });
    const y = instrument(ev, ["stooq", "ny"], {}, { wall: 2 });
    const events = [
      ...x.events,
      ...y.events,
      ev.make("note.added", N, { instrument: y.gid }, { wall: 10 }),
      claim(ev, y.gid, ["stooq", "nx"], { wall: 20 }),
    ];
    converge(events, (store) => {
      expect(row(store, "research_notes", N)?.instrument_id).toBe(x.gid);
    });
  });
});

describe("reviews", () => {
  it("done appends (done_at from doneAt), undone ends the row in every order", () => {
    const ev = new Events();
    const R1 = ulid(70);
    const R2 = ulid(71);
    const events = [
      ev.make(
        "review.done",
        R1,
        { doneAt: "2026-10-25T09:00:00.000Z", stats: { open: 2 } },
        {
          wall: 10,
        },
      ),
      ev.make("review.done", R2, { notes: "ok" }, { wall: 20 }),
      ev.make("review.undone", R2, {}, { wall: 30 }),
    ];
    converge(events, (store) => {
      expect(rows(store, "reviews")).toEqual([
        {
          gid: R1,
          module: "investments",
          done_at: "2026-10-25 09:00:00.000000",
          notes: null,
          stats: { open: 2 },
        },
      ]);
    });
  });
});
