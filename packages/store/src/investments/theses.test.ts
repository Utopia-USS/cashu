// Instrument theses and topic theses (S25 spec 4.11, 4.12; scenarios T1, T2, TT1). Synthetic data.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { converge, DEV_B, det, Events, instrument, row, rows, ulid } from "./testkit.js";

const TH = ulid(1);

describe("inv_theses", () => {
  it("create derives core_changed_at, exit_plan_changed_at only with a plan, reviewed_at from a stamp", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["xtb", "THS"]);
    store.applyEnvelopes(i.events);
    const r = store.applyEnvelopes([
      ev.make("thesis.created", TH, { instrument: i.gid }, { wall: 10 }),
      ev.make(
        "thesis.created",
        ulid(2),
        {
          instrument: i.gid,
          exitPlan: "Sprzedaz przy 20",
          stamps: { reviewed_at: "2026-05-01T00:00:00Z", core_changed_at: "2026-04-01T00:00:00Z" },
        },
        { wall: 20 },
      ),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_theses"]);
    expect(row(store, "inv_theses", TH)).toMatchObject({
      instrument_id: i.gid,
      entry_type: "trend",
      created_at: "2026-10-31 12:00:00.010000",
      updated_at: "2026-10-31 12:00:00.010000",
      core_changed_at: "2026-10-31 12:00:00.010000",
      exit_plan_changed_at: null,
      reviewed_at: null,
    });
    expect(row(store, "inv_theses", ulid(2))).toMatchObject({
      core_changed_at: "2026-04-01 00:00:00.000000",
      exit_plan_changed_at: "2026-10-31 12:00:00.020000",
      reviewed_at: "2026-05-01 00:00:00.000000",
    });
  });

  it("update derives by value: an equal write moves nothing but updated_at; reviewed sets reviewed_at", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make("thesis.created", TH, { instrument: ulid(9), exitPlan: "A" }, { wall: 10 }),
      ev.make("thesis.updated", TH, { thesis: "Teza", exitPlan: "A" }, { wall: 20 }),
    ]);
    expect(row(store, "inv_theses", TH)).toMatchObject({
      core_changed_at: "2026-10-31 12:00:00.010000",
      exit_plan_changed_at: "2026-10-31 12:00:00.010000",
      updated_at: "2026-10-31 12:00:00.020000",
    });
    store.applyEnvelopes([
      ev.make("thesis.updated", TH, { invalidation: "Spadek ponizej 5" }, { wall: 30 }),
      ev.make("thesis.updated", TH, { exitPlan: null, reviewed: true }, { wall: 40 }),
      ev.make("thesis.updated", TH, { sizePlan: "1/3" }, { wall: 50 }),
    ]);
    expect(row(store, "inv_theses", TH)).toMatchObject({
      invalidation: "Spadek ponizej 5",
      exit_plan: null,
      size_plan: "1/3",
      core_changed_at: "2026-10-31 12:00:00.030000",
      exit_plan_changed_at: null,
      reviewed_at: "2026-10-31 12:00:00.040000",
      updated_at: "2026-10-31 12:00:00.050000",
    });
  });

  it("T1: two devices change thesis and exitPlan; each derived column comes from its own event", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const events = [
      a.make("thesis.created", TH, { instrument: ulid(9) }, { wall: 10 }),
      a.make("thesis.updated", TH, { thesis: "Nowa teza" }, { wall: 20 }),
      b.make("thesis.updated", TH, { exitPlan: "Wyjscie przy 30" }, { wall: 25 }),
    ];
    converge(events, (store) => {
      expect(row(store, "inv_theses", TH)).toMatchObject({
        thesis: "Nowa teza",
        exit_plan: "Wyjscie przy 30",
        core_changed_at: "2026-10-31 12:00:00.020000",
        exit_plan_changed_at: "2026-10-31 12:00:00.025000",
        updated_at: "2026-10-31 12:00:00.025000",
      });
    });
  });

  it("T2: a delete concurrent with an update ends the row in every order", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const events = [
      a.make("thesis.created", TH, { instrument: ulid(9) }, { wall: 10 }),
      a.make("thesis.deleted", TH, {}, { wall: 20 }),
      b.make("thesis.updated", TH, { thesis: "Pozniejsza zmiana" }, { wall: 30 }),
    ];
    converge(events, (store) => expect(rows(store, "inv_theses")).toEqual([]));
  });
});

const SEG = "gold";
const TT = det("inv_topic_theses", SEG);

describe("inv_topic_theses", () => {
  it("an owner save creates, a draft over a live owner thesis is a no-op", () => {
    const store = openTestStore();
    const ev = new Events();
    const r = store.applyEnvelopes([
      ev.make(
        "topicThesis.ownerSaved",
        TT,
        { segment: SEG, thesis: "Teza wlasciciela", invalidation: null },
        { wall: 10 },
      ),
      ev.make("topicThesis.draftProposed", TT, { segment: SEG, thesis: "Szkic" }, { wall: 20 }),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_topic_theses"]);
    expect(row(store, "inv_topic_theses", TT)).toMatchObject({
      segment: SEG,
      thesis: "Teza wlasciciela",
      draft: 0,
      created_by: "owner",
      updated_at: "2026-10-31 12:00:00.010000",
    });
  });

  it("an agent draft keeps its invalidation when absent; the owner's save confirms it", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make(
        "topicThesis.draftProposed",
        TT,
        { segment: SEG, thesis: "Szkic", invalidation: "Warunek" },
        { wall: 10 },
      ),
      ev.make("topicThesis.draftProposed", TT, { segment: SEG, thesis: "Szkic 2" }, { wall: 20 }),
    ]);
    expect(row(store, "inv_topic_theses", TT)).toMatchObject({
      thesis: "Szkic 2",
      invalidation: "Warunek",
      draft: 1,
      created_by: "agent",
      core_changed_at: "2026-10-31 12:00:00.020000",
    });
    store.applyEnvelopes([
      ev.make(
        "topicThesis.ownerSaved",
        TT,
        { segment: SEG, thesis: "Szkic 2", invalidation: "Warunek" },
        { wall: 30 },
      ),
    ]);
    expect(row(store, "inv_topic_theses", TT)).toMatchObject({
      draft: 0,
      created_by: "agent", // the owner's save keeps who wrote it
      core_changed_at: "2026-10-31 12:00:00.020000", // same text: no core change
      updated_at: "2026-10-31 12:00:00.030000",
    });
  });

  it("market view: sources absent keep, a cleared view drops them, an unchanged view is a no-op", () => {
    const store = openTestStore();
    const ev = new Events();
    const src = [{ title: "Raport", url: "https://example.org/r" }];
    store.applyEnvelopes([
      ev.make(
        "topicThesis.ownerSaved",
        TT,
        { segment: SEG, thesis: "T", invalidation: null },
        { wall: 10 },
      ),
      ev.make(
        "topicThesis.marketViewSet",
        TT,
        { segment: SEG, assessment: "Popyt", outlook: null, sources: src, by: "agent" },
        { wall: 20 },
      ),
      ev.make(
        "topicThesis.marketViewSet",
        TT,
        { segment: SEG, assessment: "Popyt 2", outlook: "Wzrost", by: "owner" },
        { wall: 30 },
      ),
    ]);
    expect(row(store, "inv_topic_theses", TT)).toMatchObject({
      assessment: "Popyt 2",
      outlook: "Wzrost",
      view_sources: src,
      view_updated_at: "2026-10-31 12:00:00.030000",
      updated_at: "2026-10-31 12:00:00.030000",
    });
    store.applyEnvelopes([
      ev.make(
        "topicThesis.marketViewSet",
        TT,
        { segment: SEG, assessment: "Popyt 2", outlook: "Wzrost", by: "owner" },
        { wall: 40 },
      ),
      ev.make(
        "topicThesis.marketViewSet",
        TT,
        { segment: SEG, assessment: null, outlook: null, by: "owner" },
        { wall: 50 },
      ),
    ]);
    expect(row(store, "inv_topic_theses", TT)).toMatchObject({
      assessment: null,
      view_sources: null,
      view_updated_at: null,
      updated_at: "2026-10-31 12:00:00.050000",
    });
  });

  it("TT1: rejection, a draft inside the cooldown is a no-op, after it the row restarts", () => {
    const ev = new Events();
    const b = new Events(DEV_B, "01JB");
    const DAY = 86_400_000;
    const events = [
      ev.make(
        "topicThesis.ownerSaved",
        TT,
        { segment: SEG, thesis: "Wlasna", invalidation: "W" },
        { wall: 10 },
      ),
      b.make(
        "topicThesis.draftProposed",
        TT,
        { segment: SEG, thesis: "Rownolegly szkic" },
        {
          wall: 11,
        },
      ),
      ev.make(
        "topicThesis.marketViewSet",
        TT,
        { segment: SEG, assessment: "A", outlook: null, by: "owner" },
        { wall: 15 },
      ),
      ev.make("topicThesis.rejected", TT, {}, { wall: 20 }),
      b.make(
        "topicThesis.draftProposed",
        TT,
        { segment: SEG, thesis: "Za wczesnie" },
        {
          wall: 20 + 89 * DAY,
        },
      ),
      b.make(
        "topicThesis.draftProposed",
        TT,
        { segment: SEG, thesis: "Po karencji", invalidation: null },
        { wall: 20 + 90 * DAY },
      ),
    ];
    converge(events, (store) => {
      expect(rows(store, "inv_topic_theses")).toEqual([
        expect.objectContaining({
          thesis: "Po karencji",
          invalidation: null,
          draft: 1,
          created_by: "agent",
          rejected_at: null,
          assessment: null,
          created_at: "2027-01-29 12:00:00.020000",
          core_changed_at: "2027-01-29 12:00:00.020000",
        }),
      ]);
    });
  });
});
