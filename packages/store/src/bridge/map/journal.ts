// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the journal tables (S31a spec 4.4; events.md 8.8). Inserts are the genesis snapshot of
// `post` (`mapStrategyVersions`, `mapThesis`, `mapPlannedDeposit`, `mapDecision`); updates take every
// payload field from the genesis snapshot of `post`:
// - strategy versions and decisions: APPEND, no update event: blocked; a decision's undo (explicit
//   `undo`, covering its link deletes) is `decision.undone`;
// - theses: content columns -> `thesis.updated` (changed fields); `reviewed_at` changed ->
//   `reviewed: true`, its value never shipped (S30 deviation); delete -> `thesis.deleted`;
// - planned deposits: status -> `plannedDeposit.cancelled` / `.booked`, nothing else changes;
// - decision signal links: embedded in the `decision.recorded` of their decision, which must be
//   inserted in the same Python transaction (genesis `mapDecision` takes the links).
import type {
  InvDecisionRow,
  InvDecisionSignalRow,
  InvPlannedDepositRow,
  InvStrategyVersionRow,
  InvThesisRow,
} from "../../genesis/invStateRows.js";
import { type EventDraft, event, type MapContext } from "../../genesis/map/context.js";
import {
  decisionLinks,
  mapDecision,
  mapPlannedDeposit,
  mapStrategyVersions,
  mapThesis,
} from "../../genesis/map/journal.js";
import type { LogicalRow } from "../merge.js";
import {
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  fieldsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

function need<R>(row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock("decode");
  return row;
}

/** A change of any of `columns` no catalog event carries: block, never ship it half. */
function refuseChanged(change: RowChange<unknown>, table: string, columns: readonly string[]) {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

/** Every changed column blocks: the table's only event is its create (APPEND). */
function refuseAll(table: string) {
  return (c: RowChange<unknown>): readonly EventDraft[] => {
    refuseChanged(c, table, [...c.changed]);
    return [];
  };
}

/** The row's own gid, resolved for an explicit op whose outbox row carries none. */
function ownGid(c: RowChange<unknown>, ctx: MapContext): string {
  const gid = c.gid !== "" ? c.gid : ctx.ids.resolver.gid(c.row.table, c.row.localId);
  if (gid === undefined) throw new BridgeBlock(`unresolved:${c.row.table}`);
  return gid;
}

// ----------------------------------------------------------------------------------------------- //
// Strategy versions

const strategyVersions: TableBridge<InvStrategyVersionRow> = {
  table: "inv_strategy_versions",
  gid: "ulid",
  columns: carried(
    ["strategy.versionSaved"],
    ...["id", "profile_id", "sha256", "yaml_text", "md_text", "state", "issues", "created_at"],
  ),
  insert: (c, ctx) => {
    const mapped = mapStrategyVersions([need(c.post)], ctx)[0];
    return eventsOf("inv_strategy_versions", mapped);
  },
  update: refuseAll("inv_strategy_versions"),
};

// ----------------------------------------------------------------------------------------------- //
// Theses

/** Python column -> `thesis.updated` patch field. */
const THESIS_FIELDS: readonly (readonly [string, string])[] = [
  ["entry_type", "entryType"],
  ["thesis", "thesis"],
  ["invalidation", "invalidation"],
  ["exit_plan", "exitPlan"],
  ["size_plan", "sizePlan"],
];

function thesisSnapshot(r: InvThesisRow, ctx: MapContext): readonly EventDraft[] {
  if (ctx.ids.resolver.gid("inv_instruments", String(r.instrumentId)) === undefined) {
    throw new BridgeBlock("unresolved:inv_instruments");
  }
  return eventsOf(
    "inv_theses",
    ctx.attempt(() => mapThesis(r, ctx)),
  );
}

function thesisUpdate(c: RowChange<InvThesisRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "inv_theses", ["id", "profile_id", "instrument_id", "created_at"]);
  const post = need(c.post);
  // A review is a mark (`reviewed: true`); clearing it has no event.
  if (c.changed.has("reviewed_at") && post.reviewedAt === null) {
    throw new BridgeBlock("immutable:inv_theses:reviewed_at");
  }
  const created = pick("inv_theses", thesisSnapshot(post, ctx), "thesis.created");
  const keys = THESIS_FIELDS.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  const reviewed = c.changed.has("reviewed_at") ? { reviewed: true } : {};
  if (keys.length === 0 && !c.changed.has("reviewed_at")) return [];
  return [derived(created, "thesis.updated", { ...fieldsOf(created.data, keys), ...reviewed })];
}

const theses: TableBridge<InvThesisRow> = {
  table: "inv_theses",
  gid: "ulid",
  columns: {
    ...carried(["thesis.created"], "id", "profile_id", "instrument_id", "created_at"),
    ...carried(["thesis.created", "thesis.updated"], ...THESIS_FIELDS.map(([col]) => col)),
    ...carried(["thesis.created", "thesis.updated"], "reviewed_at"),
  },
  insert: (c, ctx) => thesisSnapshot(need(c.post), ctx),
  update: thesisUpdate,
  delete: (c) => [event("thesis.deleted", c.gid, {})],
};

// ----------------------------------------------------------------------------------------------- //
// Planned deposits

function depositUpdate(c: RowChange<InvPlannedDepositRow>, ctx: MapContext): readonly EventDraft[] {
  const table = "inv_planned_deposits";
  refuseChanged(c, table, ["id", "profile_id", "account_id", "amount", "currency"]);
  refuseChanged(c, table, ["planned_date", "note", "created_at"]);
  const post = need(c.post);
  const pre = need(c.pre);
  const terminal = ["cancelled", "booked"];
  // Booked / cancelled are terminal (FWW): only a planned row moves, and only into one of them.
  if (pre.status !== "planned" || !terminal.includes(post.status)) {
    const column = [...c.changed].find((col) =>
      ["status", "booked_txn_id", "booked_at"].includes(col),
    );
    throw new BridgeBlock(`immutable:${table}:${column ?? "status"}`);
  }
  const snap = eventsOf(
    table,
    ctx.attempt(() => mapPlannedDeposit(post, ctx)),
  );
  return [
    pick(
      table,
      snap,
      post.status === "booked" ? "plannedDeposit.booked" : "plannedDeposit.cancelled",
    ),
  ];
}

const plannedDeposits: TableBridge<InvPlannedDepositRow> = {
  table: "inv_planned_deposits",
  gid: "ulid",
  columns: {
    ...carried(
      ["plannedDeposit.created"],
      ...["id", "profile_id", "account_id", "amount", "currency", "planned_date", "note"],
      "created_at",
    ),
    ...carried(
      ["plannedDeposit.created", "plannedDeposit.cancelled", "plannedDeposit.booked"],
      "status",
    ),
    ...carried(["plannedDeposit.created", "plannedDeposit.booked"], "booked_txn_id", "booked_at"),
  },
  insert: (c, ctx) =>
    eventsOf(
      "inv_planned_deposits",
      ctx.attempt(() => mapPlannedDeposit(need(c.post), ctx)),
    ),
  update: depositUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Decisions and their signal links

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The `inv_decision_signals` links inserted in the transaction for the decision `localId`. */
function linksOf(txn: readonly LogicalRow[], localId: string): InvDecisionSignalRow[] {
  const out: InvDecisionSignalRow[] = [];
  for (const r of txn) {
    if (r.table !== "inv_decision_signals" || r.op !== "insert") continue;
    const values = r.post ?? r.fields;
    const decisionId = values.decision_id;
    const signalId = values.signal_id;
    if (!isNumber(decisionId) || !isNumber(signalId))
      throw new BridgeBlock("decode:inv_decision_signals");
    if (String(decisionId) === localId) out.push({ decisionId, signalId });
  }
  return out;
}

const decisions: TableBridge<InvDecisionRow> = {
  table: "inv_decisions",
  gid: "ulid",
  columns: carried(
    ["decision.recorded"],
    ...["id", "profile_id", "instrument_id", "account_id", "action", "quantity", "price"],
    ...["currency", "reason", "created_at"],
  ),
  insert: (c, ctx) => {
    const links = decisionLinks(linksOf(c.txn, c.row.localId));
    return eventsOf(
      "inv_decisions",
      ctx.attempt(() => mapDecision(need(c.post), links, ctx)),
    );
  },
  update: refuseAll("inv_decisions"),
  explicit: { undo: (c, ctx) => [event("decision.undone", ownGid(c, ctx), {})] },
  explicitEvents: { undo: ["decision.undone"] },
};

/**
 * A link has no event of its own: its insert travels in the `decision.recorded` of a decision
 * inserted in the same transaction. A link added to an existing decision has no catalog event;
 * deletes happen only inside a decision's undo (covered by the explicit row), any other blocks.
 */
const decisionSignals: TableBridge<InvDecisionSignalRow> = {
  table: "inv_decision_signals",
  gid: "none",
  columns: carried(["decision.recorded"], "decision_id", "signal_id"),
  insert: (c) => {
    const decision = String(need(c.post).decisionId);
    const embedded = c.txn.some(
      (r) => r.table === "inv_decisions" && r.op === "insert" && r.localId === decision,
    );
    if (!embedded) throw new BridgeBlock("unembedded:inv_decision_signals");
    return [];
  },
  update: refuseAll("inv_decision_signals"),
};

export const journalBridges: readonly TableBridge[] = [
  strategyVersions,
  theses,
  plannedDeposits,
  decisions,
  decisionSignals,
];
