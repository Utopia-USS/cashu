// Watchlist, topic thesis, research run and note bridges (S31a spec 4.4 table, S25-python-emits F4 /
// F5, events.md 8.9): each rule maps a synthetic Python change to the catalog events, validated by
// the planner. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { plan } from "../plan.js";
import { DET, idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";

const INST = "01JQ0000000000000000000010";
const RUN = "01JQ0000000000000000000011";
const NOTE = "01JQ0000000000000000000012";
const SIGNAL = "01JQ0000000000000000000013";
const WATCH = DET("watchlist_items", [INST]);
const TOPIC = DET("inv_topic_theses", ["ai"]);

const ids = idsOf({
  "inv_instruments|3": INST,
  "watchlist_items|4": WATCH,
  "inv_topic_theses|6": TOPIC,
  "research_runs|2": RUN,
  "research_notes|8": NOTE,
  "inv_signals|7": SIGNAL,
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: readonly Row[]) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids)],
    ports: testPorts(),
  });
}

function shipped(rows: readonly Row[]) {
  const r = run(rows);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

/** An update row of `table` / `localId`: `post` = `base` with `fields`, `prev` = the old values. */
function update(
  table: string,
  localId: string,
  base: Record<string, unknown>,
  fields: Record<string, unknown>,
  prev: Record<string, unknown>,
  gid: string,
): Row {
  return { table, localId, op: "update", gid, fields, prev, post: { ...base, ...fields } };
}

const keysOf = (d: Readonly<Record<string, unknown>> | undefined) => Object.keys(d ?? {}).sort();

// ----------------------------------------------------------------------------------------------- //

const watchPost = (o: Record<string, unknown> = {}) => ({
  id: 4,
  instrument_id: 3,
  note: "syn note",
  tags: ["a"],
  source: "user",
  added_at: T0,
  removed_at: null,
  ...o,
});
const watchUpdate = (fields: Record<string, unknown>, prev: Record<string, unknown>, o = {}) =>
  update("watchlist_items", "4", watchPost(o), fields, prev, WATCH);

describe("watchlist_items", () => {
  it("an insert Python could not key is watchlist.added under the DET gid of its instrument", () => {
    const { plan: p, events } = shipped([
      { table: "watchlist_items", localId: "4", post: watchPost(), fields: watchPost() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.instrument, e.d.note])).toEqual([
      ["watchlist.added", WATCH, INST, "syn note"],
    ]);
    expect(p.batches[0]?.gids).toEqual([{ table: "watchlist_items", localId: "4", gid: WATCH }]);
  });

  it("a note edit is watchlist.updated with the changed field only", () => {
    const { events } = shipped([watchUpdate({ note: "new" }, { note: "syn note" })]);
    expect(events.map((e) => e.t)).toEqual(["watchlist.updated"]);
    expect(keysOf(events[0]?.d)).toEqual(["note", "stamps"]);
  });

  it("a removal is watchlist.removed", () => {
    const { types } = shipped([watchUpdate({ removed_at: T1 }, { removed_at: null })]);
    expect(types).toEqual(["watchlist.removed"]);
  });

  it("a re-add is watchlist.added with source and only the given tags (M2)", () => {
    const { events } = shipped([
      watchUpdate(
        { removed_at: null, source: "agent", tags: ["b"] },
        { removed_at: T0, source: "user", tags: ["a"] },
        { added_at: T1 },
      ),
    ]);
    expect(events.map((e) => [e.t, e.d.source, e.d.tags])).toEqual([
      ["watchlist.added", "agent", ["b"]],
    ]);
    expect(keysOf(events[0]?.d)).toEqual(["instrument", "source", "stamps", "tags"]);
  });

  it("refuses an instrument change and a source change outside a re-add", () => {
    expect(run([watchUpdate({ instrument_id: 9 }, { instrument_id: 3 })])).toMatchObject({
      ok: false,
      reason: "immutable:watchlist_items:instrument_id",
    });
    expect(run([watchUpdate({ source: "agent" }, { source: "user" })])).toMatchObject({
      ok: false,
      reason: "immutable:watchlist_items:source",
    });
  });
});

// ----------------------------------------------------------------------------------------------- //

const topicPost = (o: Record<string, unknown> = {}) => ({
  id: 6,
  segment: "ai",
  thesis: "syn thesis",
  invalidation: "syn invalidation",
  draft: 1,
  created_by: "agent",
  core_changed_at: T0,
  created_at: T0,
  updated_at: T1,
  rejected_at: null,
  assessment: null,
  outlook: null,
  view_updated_at: null,
  view_sources: null,
  ...o,
});
const topicUpdate = (fields: Record<string, unknown>, prev: Record<string, unknown>, o = {}) =>
  update("inv_topic_theses", "6", topicPost(o), fields, prev, TOPIC);
const SOURCES = [{ title: "syn", url: "https://example.invalid/a" }];

describe("inv_topic_theses", () => {
  it("an agent draft insert is draftProposed under the DET gid of its segment", () => {
    const { events } = shipped([
      { table: "inv_topic_theses", localId: "6", post: topicPost(), fields: topicPost() },
    ]);
    expect(events.map((e) => [e.t, e.g])).toEqual([["topicThesis.draftProposed", TOPIC]]);
  });

  it("an agent rewrite that kept the invalidation leaves it out (absent = keep)", () => {
    const { events } = shipped([topicUpdate({ thesis: "new" }, { thesis: "syn thesis" })]);
    expect(events.map((e) => [e.t, e.d.thesis])).toEqual([["topicThesis.draftProposed", "new"]]);
    expect(keysOf(events[0]?.d)).toEqual(["segment", "stamps", "thesis"]);
  });

  it("the owner confirming a draft is ownerSaved with the whole text", () => {
    const { events } = shipped([topicUpdate({ draft: 0 }, { draft: 1 })]);
    expect(events.map((e) => [e.t, e.d.invalidation])).toEqual([
      ["topicThesis.ownerSaved", "syn invalidation"],
    ]);
  });

  it("a market view carries sources only when they changed", () => {
    const set = shipped([
      topicUpdate(
        { assessment: "a", outlook: "o", view_sources: SOURCES },
        { assessment: null, outlook: null, view_sources: null },
      ),
    ]);
    expect(set.events.map((e) => [e.t, e.d.assessment, e.d.sources, e.d.by])).toEqual([
      ["topicThesis.marketViewSet", "a", SOURCES, "agent"],
    ]);
    const edit = shipped([
      topicUpdate(
        { assessment: "b" },
        { assessment: "a" },
        { outlook: "o", view_sources: SOURCES, view_updated_at: T1 },
      ),
    ]);
    expect(keysOf(edit.events[0]?.d)).toEqual(["assessment", "by", "outlook", "segment", "stamps"]);
  });

  it("a cleared view is marketViewSet with both texts null", () => {
    const { events } = shipped([
      topicUpdate(
        { assessment: null, outlook: null, view_sources: null },
        { assessment: "a", outlook: "o", view_sources: SOURCES },
      ),
    ]);
    expect(events.map((e) => [e.t, e.d.segment, e.d.assessment, e.d.outlook, e.d.sources])).toEqual(
      [["topicThesis.marketViewSet", "ai", null, null, null]],
    );
  });

  it("a delete is rejected; an owner write on the rejected row restarts it alone", () => {
    const del = shipped([topicUpdate({ rejected_at: T1 }, { rejected_at: null })]);
    expect(del.types).toEqual(["topicThesis.rejected"]);
    const restart = shipped([
      topicUpdate(
        {
          rejected_at: null,
          draft: 0,
          created_by: "owner",
          created_at: T1,
          invalidation: null,
          assessment: null,
        },
        {
          rejected_at: T0,
          draft: 1,
          created_by: "agent",
          created_at: T0,
          invalidation: "x",
          assessment: "a",
        },
      ),
    ]);
    expect(restart.events.map((e) => [e.t, e.d.invalidation])).toEqual([
      ["topicThesis.ownerSaved", null],
    ]);
  });

  it("refuses a segment change", () => {
    expect(run([topicUpdate({ segment: "bio" }, { segment: "ai" })])).toMatchObject({
      ok: false,
      reason: "immutable:inv_topic_theses:segment",
    });
  });
});

// ----------------------------------------------------------------------------------------------- //

const runPost = (o: Record<string, unknown> = {}) => ({
  id: 2,
  started_at: T0,
  finished_at: null,
  status: "running",
  scope: { held: true },
  counts: {},
  created_by: "agent",
  ...o,
});
const runUpdate = (fields: Record<string, unknown>, prev: Record<string, unknown>) =>
  update("research_runs", "2", runPost(), fields, prev, RUN);

describe("research_runs", () => {
  it("a started run is researchRun.started; finishing it is researchRun.finished", () => {
    const start = shipped([
      { table: "research_runs", localId: "2", gid: RUN, post: runPost(), fields: runPost() },
    ]);
    expect(start.types).toEqual(["researchRun.started"]);
    const finish = shipped([
      runUpdate(
        { status: "done", finished_at: T1, counts: { notes: 2 } },
        { status: "running", finished_at: null, counts: {} },
      ),
    ]);
    expect(finish.events.map((e) => [e.t, e.d.status, e.d.counts])).toEqual([
      ["researchRun.finished", "done", { notes: 2 }],
    ]);
  });

  it("refuses a scope change and a status that is not a finish", () => {
    expect(run([runUpdate({ scope: { held: false } }, { scope: { held: true } })])).toMatchObject({
      ok: false,
      reason: "immutable:research_runs:scope",
    });
    expect(run([runUpdate({ counts: { notes: 1 } }, { counts: {} })])).toMatchObject({
      ok: false,
      reason: "immutable:research_runs:status",
    });
  });
});

// ----------------------------------------------------------------------------------------------- //

const notePost = (o: Record<string, unknown> = {}) => ({
  id: 8,
  run_id: 2,
  instrument_id: 3,
  theme: null,
  segment: null,
  kind: "candidate",
  polarity: "positive",
  strength: 2,
  thesis_relation: "none",
  thesis_field: null,
  title: "syn title",
  summary: "syn summary",
  sources: SOURCES,
  details: { reason: "syn" },
  candidate_key: "SYN",
  signal_id: null,
  observed_at: T0,
  expires_at: "2026-04-01 10:00:00.000000",
  created_by: "agent",
  dismissed_at: null,
  cooldown_until: null,
  created_at: T0,
  updated_at: T0,
  read_at: null,
  ...o,
});
const noteUpdate = (fields: Record<string, unknown>, prev: Record<string, unknown>, o = {}) =>
  update("research_notes", "8", notePost(o), fields, prev, NOTE);

describe("research_notes", () => {
  it("an insert is note.added with its references as gids", () => {
    const { events } = shipped([
      { table: "research_notes", localId: "8", gid: NOTE, post: notePost(), fields: notePost() },
    ]);
    expect(events.map((e) => [e.t, e.d.run, e.d.instrument])).toEqual([["note.added", RUN, INST]]);
  });

  it("a candidate accept fills the unchanged instrument (whole value, S25-F4)", () => {
    const { events } = shipped([
      noteUpdate({ details: { reason: "syn", accepted: true } }, { details: { reason: "syn" } }),
    ]);
    expect(events.map((e) => [e.t, e.d.instrument, e.d.details])).toEqual([
      ["note.candidateUpdated", INST, { reason: "syn", accepted: true }],
    ]);
    expect(keysOf(events[0]?.d)).toEqual(["details", "instrument", "stamps"]);
  });

  it("the candidate's watchlist row in the same transaction is caused by the note update", () => {
    const { events } = shipped([
      noteUpdate({ details: { accepted: true } }, { details: { reason: "syn" } }),
      { table: "watchlist_items", localId: "4", post: watchPost(), fields: watchPost() },
    ]);
    expect(events.map((e) => e.t)).toEqual(["note.candidateUpdated", "watchlist.added"]);
    expect(events[1]?.c).toBe(events[0]?.i);
  });

  it("a signal relink is note.signalLinked (S25-F5)", () => {
    const { events } = shipped([noteUpdate({ signal_id: 7 }, { signal_id: null })]);
    expect(events.map((e) => [e.t, e.d.signal])).toEqual([["note.signalLinked", SIGNAL]]);
  });

  it("read, dismiss and restore", () => {
    expect(shipped([noteUpdate({ read_at: T1 }, { read_at: null })]).types).toEqual(["note.read"]);
    const until = "2026-06-01 10:00:00.000000";
    const dismiss = shipped([
      noteUpdate(
        { dismissed_at: T1, cooldown_until: until },
        { dismissed_at: null, cooldown_until: null },
      ),
    ]);
    expect(dismiss.events.map((e) => [e.t, e.d.cooldownUntil])).toEqual([
      ["note.dismissed", "2026-06-01T10:00:00.000000Z"],
    ]);
    const restore = shipped([
      noteUpdate(
        { dismissed_at: null, cooldown_until: null },
        { dismissed_at: T1, cooldown_until: until },
      ),
    ]);
    expect(restore.types).toEqual(["note.restored"]);
  });

  it("refuses a change of a column no Python writer changes after the insert", () => {
    expect(run([noteUpdate({ title: "new" }, { title: "syn title" })])).toMatchObject({
      ok: false,
      reason: "immutable:research_notes:title",
    });
  });
});
