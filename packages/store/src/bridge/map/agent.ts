// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the agent layer and connector bindings (S31a spec 4.4 table; events.md 8.10, 10).
// Inserts are the genesis snapshot (`mapReview`, `mapProposal`, `mapConnectorBinding`); updates take
// every payload field from the genesis snapshot of `post`:
// - reviews: append only; the explicit `undo` (`core/reviews.py:undo`) -> `review.undone`;
// - proposals: status to approved / rejected (with the note) / failed -> the terminal event (the
//   planner links the transaction's other events to it, spec 6.6); approved -> failed (the change
//   could not be completed after the decision) -> `proposal.applyFailed` (S31c); `applying` is a
//   device-local lock (Python's filter drops pending -> applying, applying -> pending ships no event);
// - connector bindings: params / auto-commit -> `connectorBinding.set` (whole value); `cursor` ->
//   `connectorBinding.cursorAdvanced` (leader); delete -> `connectorBinding.removed`. The fetch
//   state (`last_*`, `backoff_until`) is leader-local and never reaches the outbox.
import type { EventType } from "../../events/v1/catalog.js";
import { mapConnectorBinding, mapProposal, mapReview } from "../../genesis/map/agent.js";
import { type EventDraft, event, type MapContext } from "../../genesis/map/context.js";
import type { ConnectorBindingRow, ProposalRow, ReviewRow } from "../../genesis/rows.js";
import {
  anyChanged,
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

function need<R>(row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock("decode");
  return row;
}

/** A change of a column the catalog has no update event for: block, never ship it half. */
function refuseChanged(change: RowChange<unknown>, table: string, columns: readonly string[]) {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

// ----------------------------------------------------------------------------------------------- //
// Reviews

const REVIEWS = "reviews";

const reviews: TableBridge<ReviewRow> = {
  table: REVIEWS,
  gid: "ulid",
  columns: {
    ...carried(["review.done"], "id", "profile_id", "module", "done_at", "notes", "stats"),
  },
  insert: (c, ctx) =>
    eventsOf(
      REVIEWS,
      ctx.attempt(() => mapReview(need(c.post), ctx)),
    ),
  // The explicit undo covers the row's delete (S30 `emit_row`): the gid is the review's own.
  explicit: {
    undo: (c) => {
      if (c.gid === "") throw new BridgeBlock(`unresolved:${REVIEWS}`);
      return [event("review.undone", c.gid, {})];
    },
  },
  explicitEvents: { undo: ["review.undone"] },
};

// ----------------------------------------------------------------------------------------------- //
// Proposals

const PROPOSALS = "proposals";
const TERMINAL: Readonly<Record<string, EventType>> = {
  approved: "proposal.approved",
  rejected: "proposal.rejected",
  failed: "proposal.failed",
};
const TERMINAL_EVENTS: readonly EventType[] = Object.values(TERMINAL);

function proposalSnapshot(row: ProposalRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    PROPOSALS,
    ctx.attempt(() => mapProposal(row, ctx)),
  );
}

function proposalUpdate(c: RowChange<ProposalRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, PROPOSALS, ["kind", "summary", "reason", "payload", "source", "created_at"]);
  const post = need(c.post);
  if (!c.changed.has("status")) {
    // A result or review time moves only with the terminal status.
    refuseChanged(c, PROPOSALS, ["result", "reviewed_at"]);
    return [];
  }
  const snapshot = proposalSnapshot(post, ctx);
  if (c.pre?.status === "approved" && post.status === "failed") {
    // The approved change could not be completed (Python `_finish`): the execution result, not a
    // second decision (S31c); it revokes the approval's caused side effects (events.md 6.6).
    const failed = pick(PROPOSALS, snapshot, "proposal.failed");
    return [derived(failed, "proposal.applyFailed", { result: failed.data.result })];
  }
  const terminal = TERMINAL[post.status];
  if (terminal !== undefined) return [pick(PROPOSALS, snapshot, terminal)];
  // applying -> pending: the device-local lock released, nothing was decided.
  if (post.status === "pending" && !anyChanged(c, "result", "reviewed_at")) return [];
  throw new BridgeBlock(`immutable:${PROPOSALS}:status`);
}

const proposals: TableBridge<ProposalRow> = {
  table: PROPOSALS,
  gid: "ulid",
  columns: {
    ...carried(
      ["proposal.created"],
      "id",
      "profile_id",
      "kind",
      "summary",
      "reason",
      "payload",
      "source",
      "created_at",
    ),
    ...carried(
      ["proposal.created", ...TERMINAL_EVENTS, "proposal.applyFailed"],
      "status",
      "result",
      "reviewed_at",
    ),
  },
  insert: (c, ctx) => proposalSnapshot(need(c.post), ctx),
  update: proposalUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Connector bindings

const BINDINGS = "connector_bindings";

function bindingSnapshot(row: ConnectorBindingRow, ctx: MapContext): readonly EventDraft[] {
  // `mapConnectorBinding` takes the account as guaranteed: an unresolved one blocks here first.
  if (ctx.ids.resolver.gid("accounts", String(row.accountId)) === undefined) {
    throw new BridgeBlock(`unresolved:${BINDINGS}`);
  }
  return eventsOf(
    BINDINGS,
    ctx.attempt(() => mapConnectorBinding(row, ctx)),
  );
}

function bindingUpdate(c: RowChange<ConnectorBindingRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, BINDINGS, ["account_id", "connector_id", "created_at"]);
  const post = need(c.post);
  const snap = bindingSnapshot(post, ctx);
  const set = pick(BINDINGS, snap, "connectorBinding.set");
  const out: EventDraft[] = [];
  if (anyChanged(c, "params_json", "auto_commit")) out.push(set);
  if (c.changed.has("cursor")) {
    // Genesis emits the cursor only when one is stored; a cleared cursor ships as null.
    const cursor = snap.find((e) => e.type === "connectorBinding.cursorAdvanced");
    out.push(cursor ?? derived(set, "connectorBinding.cursorAdvanced", { cursor: null }));
  }
  return out;
}

const bindings: TableBridge<ConnectorBindingRow> = {
  table: BINDINGS,
  gid: "det",
  columns: {
    ...carried(
      ["connectorBinding.set"],
      "id",
      "profile_id",
      "account_id",
      "connector_id",
      "created_at",
      "params_json",
      "auto_commit",
    ),
    ...carried(["connectorBinding.set", "connectorBinding.cursorAdvanced"], "cursor"),
  },
  insert: (c, ctx) => bindingSnapshot(need(c.post), ctx),
  update: bindingUpdate,
  // A delete's last state lacks the derived fetch columns (no decoded row): the event is empty.
  delete: (c) => [event("connectorBinding.removed", c.gid, {})],
};

export const agentBridges: readonly TableBridge[] = [reviews, proposals, bindings];
