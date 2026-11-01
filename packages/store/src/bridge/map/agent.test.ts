// Review, proposal and connector binding bridges (S31a spec 4.4 table, 6.6; events.md 8.10, 10):
// each rule maps a synthetic Python change to the catalog events, validated by the planner.
// Synthetic rows only.
import { describe, expect, it } from "vitest";
import { plan } from "../plan.js";
import { DET, idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";

const ACCOUNT = "01JQ0000000000000000000020";
const REVIEW = "01JQ0000000000000000000021";
const PROPOSAL = "01JQ0000000000000000000022";
const BINDING = DET("connector_bindings", [ACCOUNT, "syn-conn"]);
const VERSION = "01JQ0000000000000000000023";

const ids = idsOf({
  "accounts|1": ACCOUNT,
  "reviews|5": REVIEW,
  "proposals|9": PROPOSAL,
  "connector_bindings|3": BINDING,
  "inv_strategy_versions|4": VERSION,
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: readonly Row[], leader = true) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids)],
    ports: testPorts(leader),
  });
}

function shipped(rows: readonly Row[], leader = true) {
  const r = run(rows, leader);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

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

// ----------------------------------------------------------------------------------------------- //

const reviewPost = () => ({
  id: 5,
  module: "investments",
  done_at: T0,
  notes: null,
  stats: { signals: 1 },
});
const reviewInsert: Row = {
  table: "reviews",
  localId: "5",
  gid: REVIEW,
  post: reviewPost(),
  fields: reviewPost(),
};

describe("reviews", () => {
  it("an insert is review.done; the explicit undo is review.undone", () => {
    expect(shipped([reviewInsert]).types).toEqual(["review.done"]);
    const undo = shipped([{ table: "reviews", localId: "5", op: "undo", gid: REVIEW }]);
    expect(undo.events.map((e) => [e.t, e.g])).toEqual([["review.undone", REVIEW]]);
  });

  it("blocks an undo of a review without a gid and any update", () => {
    expect(run([{ table: "reviews", localId: "99", op: "undo" }])).toMatchObject({
      ok: false,
      reason: "unresolved:reviews",
    });
    expect(
      run([update("reviews", "5", reviewPost(), { notes: "x" }, { notes: null }, REVIEW)]),
    ).toMatchObject({ ok: false, reason: "no-update-mapper:reviews" });
  });
});

// ----------------------------------------------------------------------------------------------- //

const proposalPost = (o: Record<string, unknown> = {}) => ({
  id: 9,
  kind: "strategy",
  status: "pending",
  summary: "syn summary",
  reason: null,
  payload: { yaml: "syn" },
  result: {},
  source: "agent",
  created_at: T0,
  reviewed_at: null,
  ...o,
});
const proposalUpdate = (fields: Record<string, unknown>, prev: Record<string, unknown>) =>
  update("proposals", "9", proposalPost(), fields, prev, PROPOSAL);

describe("proposals", () => {
  it("an insert is proposal.created", () => {
    const { types } = shipped([
      {
        table: "proposals",
        localId: "9",
        gid: PROPOSAL,
        post: proposalPost(),
        fields: proposalPost(),
      },
    ]);
    expect(types).toEqual(["proposal.created"]);
  });

  it("an approval is proposal.approved, the cause of its transaction's other events (6.6)", () => {
    const { events } = shipped([
      proposalUpdate(
        { status: "approved", reviewed_at: T1, result: { version: 2 } },
        { status: "applying", reviewed_at: null, result: {} },
      ),
      reviewInsert,
    ]);
    expect(events.map((e) => [e.t, e.d.result])).toEqual([
      ["proposal.approved", { version: 2 }],
      ["review.done", undefined],
    ]);
    expect(events[1]?.c).toBe(events[0]?.i);
  });

  it("a rejection and a failure are their terminal events", () => {
    const rejected = shipped([
      proposalUpdate(
        { status: "rejected", reviewed_at: T1, result: { note: "no" } },
        { status: "pending", reviewed_at: null, result: {} },
      ),
    ]);
    expect(rejected.events.map((e) => [e.t, e.d.note])).toEqual([["proposal.rejected", "no"]]);
    const silent = shipped([
      proposalUpdate(
        { status: "rejected", reviewed_at: T1 },
        { status: "pending", reviewed_at: null },
      ),
    ]);
    expect(silent.events.map((e) => e.d.note)).toEqual([null]);
    const failed = shipped([
      proposalUpdate(
        { status: "failed", reviewed_at: T1, result: { error_code: "interrupted" } },
        { status: "applying", reviewed_at: null, result: {} },
      ),
    ]);
    expect(failed.events.map((e) => [e.t, e.d.result])).toEqual([
      ["proposal.failed", { error_code: "interrupted" }],
    ]);
  });

  it("approved -> failed is proposal.applyFailed; the undone strategy version ships nothing", () => {
    const versionRow = {
      id: 4,
      profile_id: 1,
      version: 2,
      sha256: "b".repeat(64),
      yaml_text: "cele: []",
      md_text: null,
      state: "valid",
      issues: [],
      created_at: T1,
    };
    const undo: Row = {
      table: "inv_strategy_versions",
      localId: "4",
      op: "delete",
      gid: VERSION,
      fields: versionRow,
    };
    const fail = update(
      "proposals",
      "9",
      proposalPost({ status: "approved", reviewed_at: T1 }),
      { status: "failed", result: { error_code: "write_failed" } },
      { status: "approved", result: { version: 2 } },
      PROPOSAL,
    );
    const { plan: p, events } = shipped([fail, undo]);
    expect(events.map((e) => [e.t, e.g, e.d.result, e.c])).toEqual([
      ["proposal.applyFailed", PROPOSAL, { error_code: "write_failed" }, undefined],
    ]);
    expect(p.counts.noEvent).toBe(1);
    // A version delete outside such a transaction has no catalog event.
    expect(run([undo])).toMatchObject({
      ok: false,
      reason: "no-delete-event:inv_strategy_versions",
    });
  });

  it("releasing the device-local applying lock ships nothing", () => {
    const { plan: p, types } = shipped([
      proposalUpdate({ status: "pending" }, { status: "applying" }),
    ]);
    expect(types).toEqual([]);
    expect(p.counts.noEvent).toBe(1);
  });

  it("refuses a change of the proposal itself and a result without a status", () => {
    expect(run([proposalUpdate({ summary: "x" }, { summary: "syn summary" })])).toMatchObject({
      ok: false,
      reason: "immutable:proposals:summary",
    });
    expect(run([proposalUpdate({ result: { a: 1 } }, { result: {} })])).toMatchObject({
      ok: false,
      reason: "immutable:proposals:result",
    });
  });
});

// ----------------------------------------------------------------------------------------------- //

const bindingPost = (o: Record<string, unknown> = {}) => ({
  id: 3,
  account_id: 1,
  connector_id: "syn-conn",
  params_json: { region: "a" },
  auto_commit: 0,
  cursor: null,
  last_run_at: null,
  last_status: null,
  last_ok_at: null,
  backoff_until: null,
  created_at: T0,
  updated_at: T0,
  ...o,
});
const bindingUpdate = (
  fields: Record<string, unknown>,
  prev: Record<string, unknown>,
  o: Record<string, unknown> = {},
) => update("connector_bindings", "3", bindingPost(o), fields, prev, BINDING);

describe("connector_bindings", () => {
  it("an insert Python could not key is connectorBinding.set under its DET gid", () => {
    const { plan: p, events } = shipped([
      { table: "connector_bindings", localId: "3", post: bindingPost(), fields: bindingPost() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.account, e.d.autoCommit])).toEqual([
      ["connectorBinding.set", BINDING, ACCOUNT, false],
    ]);
    expect(p.batches[0]?.gids).toEqual([
      { table: "connector_bindings", localId: "3", gid: BINDING },
    ]);
  });

  it("a params edit is connectorBinding.set with the whole value", () => {
    const { events } = shipped([bindingUpdate({ auto_commit: 1 }, { auto_commit: 0 })]);
    expect(events.map((e) => [e.t, e.d.params, e.d.autoCommit])).toEqual([
      ["connectorBinding.set", { region: "a" }, true],
    ]);
  });

  it("a cursor move is cursorAdvanced on the leader, dropped elsewhere; a cleared one is null", () => {
    const row = bindingUpdate({ cursor: "c2" }, { cursor: "c1" }, { last_ok_at: T1 });
    expect(shipped([row]).events.map((e) => [e.t, e.d.cursor])).toEqual([
      ["connectorBinding.cursorAdvanced", "c2"],
    ]);
    const follower = shipped([row], false);
    expect(follower.types).toEqual([]);
    expect(follower.plan.counts.notLeader).toBe(1);
    const cleared = shipped([bindingUpdate({ cursor: null }, { cursor: "c1" })]);
    expect(cleared.events.map((e) => [e.t, e.d.cursor])).toEqual([
      ["connectorBinding.cursorAdvanced", null],
    ]);
  });

  it("a delete is connectorBinding.removed", () => {
    // A delete's `fields` = the last synced state (no derived fetch columns).
    const synced = {
      id: 3,
      account_id: 1,
      connector_id: "syn-conn",
      params_json: { region: "a" },
      auto_commit: 0,
      cursor: null,
      created_at: T0,
    };
    const { events } = shipped([
      { table: "connector_bindings", localId: "3", op: "delete", gid: BINDING, fields: synced },
    ]);
    expect(events.map((e) => [e.t, e.g])).toEqual([["connectorBinding.removed", BINDING]]);
  });

  it("refuses a key change and blocks an insert whose account has no gid", () => {
    expect(
      run([bindingUpdate({ connector_id: "other" }, { connector_id: "syn-conn" })]),
    ).toMatchObject({ ok: false, reason: "immutable:connector_bindings:connector_id" });
    const orphan = bindingPost({ account_id: 2 });
    expect(
      run([{ table: "connector_bindings", localId: "3", post: orphan, fields: orphan }]),
    ).toMatchObject({ ok: false, reason: "unresolved:connector_bindings" });
  });
});
