// Journal bridges (S31a spec 4.4; events.md 8.8): strategy versions, theses, planned deposits,
// decisions with their embedded signal links. Each rule maps a synthetic Python change to the
// catalog events, validated by the planner. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { plan } from "../plan.js";
import { idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";

const INSTRUMENT_GID = "01JQ0000000000000000000021";
const ACCOUNT_GID = "01JQ0000000000000000000022";
const STRATEGY_GID = "01JQ0000000000000000000023";
const THESIS_GID = "01JQ0000000000000000000024";
const DEPOSIT_GID = "01JQ0000000000000000000025";
const DECISION_GID = "01JQ0000000000000000000026";
const SIGNAL_A = "01JQ0000000000000000000027";
const SIGNAL_B = "01JQ0000000000000000000028";
const TXN_GID = "01JQ0000000000000000000029";

const ids = idsOf({
  "inv_instruments|3": INSTRUMENT_GID,
  "accounts|1": ACCOUNT_GID,
  "inv_theses|4": THESIS_GID,
  "inv_planned_deposits|5": DEPOSIT_GID,
  "inv_decisions|6": DECISION_GID,
  "inv_signals|7": SIGNAL_A,
  "inv_signals|8": SIGNAL_B,
  "inv_transactions|9": TXN_GID,
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: Row[]) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids)],
    ports: testPorts(),
  });
}

function shipped(rows: Row[]) {
  const r = run(rows);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

const blockOf = (rows: Row[]) => {
  const r = run(rows);
  return r.ok ? "ok" : r.reason;
};

describe("strategy versions", () => {
  const version = {
    id: 2,
    version: 3,
    sha256: "b".repeat(64),
    yaml_text: "goals: []\n",
    md_text: null,
    state: "valid",
    issues: [],
    created_at: T0,
  };

  it("an insert is strategy.versionSaved; an update blocks (APPEND)", () => {
    const { events } = shipped([
      {
        table: "inv_strategy_versions",
        localId: "2",
        gid: STRATEGY_GID,
        fields: version,
        post: version,
      },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.sha256, e.d.state])).toEqual([
      ["strategy.versionSaved", STRATEGY_GID, "b".repeat(64), "valid"],
    ]);
    const update = {
      table: "inv_strategy_versions",
      localId: "2",
      op: "update" as const,
      gid: STRATEGY_GID,
      fields: { state: "invalid" },
      prev: { state: "valid" },
      post: { ...version, state: "invalid" },
    };
    expect(blockOf([update])).toBe("immutable:inv_strategy_versions:state");
  });
});

describe("theses", () => {
  const thesis = (o: Record<string, unknown> = {}) => ({
    id: 4,
    instrument_id: 3,
    entry_type: "trend",
    thesis: "syn thesis",
    invalidation: null,
    exit_plan: null,
    size_plan: null,
    reviewed_at: null,
    created_at: T0,
    updated_at: T0,
    core_changed_at: T0,
    exit_plan_changed_at: null,
    ...o,
  });

  it("an insert is thesis.created with the derived stamps", () => {
    const { events } = shipped([
      { table: "inv_theses", localId: "4", gid: THESIS_GID, fields: thesis(), post: thesis() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.instrument])).toEqual([
      ["thesis.created", THESIS_GID, INSTRUMENT_GID],
    ]);
    expect(events[0]?.d.stamps).toMatchObject({ core_changed_at: "2026-03-01T10:00:00.000000Z" });
  });

  it("an edit is thesis.updated with the changed fields; a review adds reviewed: true only", () => {
    const { events } = shipped([
      {
        table: "inv_theses",
        localId: "4",
        op: "update",
        fields: { exit_plan: "sell at 2x", reviewed_at: T1 },
        prev: { exit_plan: null, reviewed_at: null },
        post: thesis({
          exit_plan: "sell at 2x",
          reviewed_at: T1,
          exit_plan_changed_at: T1,
          updated_at: T1,
        }),
      },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.exitPlan, e.d.reviewed])).toEqual([
      ["thesis.updated", THESIS_GID, "sell at 2x", true],
    ]);
    expect(Object.keys(events[0]?.d ?? {}).sort()).toEqual(["exitPlan", "reviewed", "stamps"]);
    const review = shipped([
      {
        table: "inv_theses",
        localId: "4",
        op: "update",
        fields: { reviewed_at: T1 },
        prev: { reviewed_at: T0 },
        post: thesis({ reviewed_at: T1 }),
      },
    ]);
    expect(review.events.map((e) => [e.t, Object.keys(e.d).sort()])).toEqual([
      ["thesis.updated", ["reviewed", "stamps"]],
    ]);
  });

  it("a delete is thesis.deleted; moving a thesis to another instrument blocks", () => {
    const del = shipped([{ table: "inv_theses", localId: "4", op: "delete", fields: thesis() }]);
    expect(del.events.map((e) => [e.t, e.g])).toEqual([["thesis.deleted", THESIS_GID]]);
    const moved = {
      table: "inv_theses",
      localId: "4",
      op: "update" as const,
      fields: { instrument_id: 5 },
      prev: { instrument_id: 3 },
      post: thesis({ instrument_id: 5 }),
    };
    expect(blockOf([moved])).toBe("immutable:inv_theses:instrument_id");
  });
});

describe("planned deposits", () => {
  const deposit = (o: Record<string, unknown> = {}) => ({
    id: 5,
    account_id: 1,
    amount: "500",
    currency: "PLN",
    planned_date: "2026-03-10",
    note: null,
    status: "planned",
    booked_txn_id: null,
    booked_at: null,
    created_at: T0,
    updated_at: T0,
    ...o,
  });

  it("an insert is plannedDeposit.created", () => {
    const { events } = shipped([
      {
        table: "inv_planned_deposits",
        localId: "5",
        gid: DEPOSIT_GID,
        fields: deposit(),
        post: deposit(),
      },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.account, e.d.amount])).toEqual([
      ["plannedDeposit.created", DEPOSIT_GID, ACCOUNT_GID, "500"],
    ]);
  });

  it("a cancel is plannedDeposit.cancelled; a booking is plannedDeposit.booked {txn}", () => {
    const cancel = shipped([
      {
        table: "inv_planned_deposits",
        localId: "5",
        op: "update",
        fields: { status: "cancelled" },
        prev: { status: "planned" },
        post: deposit({ status: "cancelled", updated_at: T1 }),
      },
    ]);
    expect(cancel.types).toEqual(["plannedDeposit.cancelled"]);
    const book = shipped([
      {
        table: "inv_planned_deposits",
        localId: "5",
        op: "update",
        fields: { status: "booked", booked_txn_id: 9, booked_at: T1 },
        prev: { status: "planned", booked_txn_id: null, booked_at: null },
        post: deposit({ status: "booked", booked_txn_id: 9, booked_at: T1, updated_at: T1 }),
      },
    ]);
    expect(book.events.map((e) => [e.t, e.g, e.d.txn])).toEqual([
      ["plannedDeposit.booked", DEPOSIT_GID, TXN_GID],
    ]);
  });

  it("an amount edit or a terminal status leaving blocks", () => {
    const base = { table: "inv_planned_deposits", localId: "5", op: "update" as const };
    expect(
      blockOf([
        {
          ...base,
          fields: { amount: "600" },
          prev: { amount: "500" },
          post: deposit({ amount: "600" }),
        },
      ]),
    ).toBe("immutable:inv_planned_deposits:amount");
    expect(
      blockOf([
        { ...base, fields: { status: "planned" }, prev: { status: "cancelled" }, post: deposit() },
      ]),
    ).toBe("immutable:inv_planned_deposits:status");
  });
});

describe("decisions and their signal links", () => {
  const decision = (o: Record<string, unknown> = {}) => ({
    id: 6,
    signal_id: 8,
    instrument_id: 3,
    account_id: null,
    action: "held",
    quantity: null,
    price: null,
    currency: null,
    reason: "syn",
    created_at: T0,
    ...o,
  });
  const link = (signal: number) => ({
    table: "inv_decision_signals",
    localId: `6|${signal}`,
    fields: { decision_id: 6, signal_id: signal },
    post: { decision_id: 6, signal_id: signal },
  });

  it("an insert embeds the links of its transaction: signal_id first, then by id", () => {
    const { events, plan: p } = shipped([
      {
        table: "inv_decisions",
        localId: "6",
        gid: DECISION_GID,
        fields: decision(),
        post: decision(),
      },
      link(7),
      link(8),
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.signals, e.d.instrument, e.d.action])).toEqual([
      ["decision.recorded", DECISION_GID, [SIGNAL_B, SIGNAL_A], INSTRUMENT_GID, "held"],
    ]);
    expect(p.counts.noEvent).toBe(2);
  });

  it("a link without its decision insert in the transaction blocks", () => {
    expect(blockOf([link(7)])).toBe("unembedded:inv_decision_signals");
  });

  it("an undo is decision.undone (resolved through sync_ids); an update blocks", () => {
    const undo = shipped([{ table: "inv_decisions", localId: "6", op: "undo", fields: {} }]);
    expect(undo.events.map((e) => [e.t, e.g, Object.keys(e.d)])).toEqual([
      ["decision.undone", DECISION_GID, []],
    ]);
    const edit = {
      table: "inv_decisions",
      localId: "6",
      op: "update" as const,
      fields: { reason: "x" },
      prev: { reason: "syn" },
      post: decision({ reason: "x" }),
    };
    expect(blockOf([edit])).toBe("immutable:inv_decisions:reason");
    expect(blockOf([{ table: "inv_decisions", localId: "60", op: "undo", fields: {} }])).toBe(
      "unresolved:inv_decisions",
    );
  });

  it("a link delete outside an undo blocks", () => {
    expect(
      blockOf([
        {
          table: "inv_decision_signals",
          localId: "6|7",
          op: "delete",
          fields: { decision_id: 6, signal_id: 7 },
        },
      ]),
    ).toBe("no-delete-event:inv_decision_signals");
  });
});
