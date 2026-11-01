// Genesis row mappers, agent layer and connectors (S26 spec 4.10, D-G9, D-G10; events.md 8.10, 10):
// reviews, proposals with their terminal state (approvals emit no side effects: those are rows of
// their own tables), connector bindings with their cursor, and the device-local sidecar (the
// notification log and the connector fetch state never enter the log).

import { isJsonObject } from "../idFields.js";
import type { InvNotificationRow } from "../invStateRows.js";
import type { ConnectorBindingRow, ProposalRow, ReviewRow } from "../rows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

export function mapReview(r: ReviewRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "reviews", r.id);
  if (gid === undefined) return undefined;
  const data = {
    module: r.module,
    doneAt: r.doneAt,
    notes: r.notes,
    stats: ctx.rw.json("reviews", "stats", r.stats),
  };
  return rowEvents("reviews", r.id, [event("review.done", gid, data, stampsOf(r, ["doneAt"]))]);
}

/**
 * `proposal.created` (payload ids and staged paths rewritten, 6.5), then the terminal event of an
 * approved / rejected (with the owner's note) / failed proposal. `applying` is a device-local lock: the proposal stays
 * pending (D-G9, counted `applying_as_pending`); another status is `bad_enum`.
 */
export function mapProposal(r: ProposalRow, ctx: MapContext): RowEvents | undefined {
  const t = "proposals";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, ["createdAt", "reviewedAt"]);
  const created = {
    kind: r.kind,
    summary: r.summary,
    reason: r.reason,
    payload: ctx.rw.json(t, "payload", r.payload),
    source: r.source,
  };
  const events = [event("proposal.created", gid, created, stamps)];
  switch (r.status) {
    case "pending":
      break;
    case "applying":
      ctx.count(t, "applying_as_pending");
      break;
    case "approved":
    case "failed": {
      const result = { result: ctx.rw.json(t, "result", r.result) };
      const type = r.status === "approved" ? "proposal.approved" : "proposal.failed";
      events.push(event(type, gid, result, stamps));
      break;
    }
    case "rejected": {
      // Python `reject` keeps the owner's note as `result.note` (S31c).
      const note = isJsonObject(r.result) ? r.result.note : undefined;
      const data = { note: typeof note === "string" && note !== "" ? note : null };
      events.push(event("proposal.rejected", gid, data, stamps));
      break;
    }
    default:
      ctx.count(t, "bad_enum");
      return undefined;
  }
  return rowEvents(t, r.id, events);
}

/** `connectorBinding.set`, then `cursorAdvanced` (no cause) when a cursor is stored. */
export function mapConnectorBinding(
  r: ConnectorBindingRow,
  ctx: MapContext,
): RowEvents | undefined {
  const t = "connector_bindings";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, ["createdAt", "updatedAt"]);
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    connectorId: r.connectorId,
    params: ctx.rw.json(t, "params_json", r.paramsJson),
    autoCommit: r.autoCommit,
  };
  const events = [event("connectorBinding.set", gid, data, stamps)];
  if (r.cursor !== null) {
    events.push(event("connectorBinding.cursorAdvanced", gid, { cursor: r.cursor }, stamps));
  }
  return rowEvents(t, r.id, events);
}

/** D-G10: what a device keeps for itself, loaded by S48 next to the vault (never synced). */
export interface DeviceLocal {
  /** `inv_notification_log` rows whose signal is exported, by ascending id. */
  readonly notifications: readonly {
    readonly signal: string;
    readonly severity: string;
    readonly createdAt: string;
    readonly sentAt: string | null;
    readonly channel: string | null;
  }[];
  /** The leader-local fetch state of every exported binding, by ascending id. */
  readonly connectorFetch: readonly {
    readonly binding: string;
    readonly lastRunAt: string | null;
    readonly lastStatus: string | null;
    readonly lastOkAt: string | null;
    readonly backoffUntil: string | null;
  }[];
}

/**
 * The device-local sidecar of a vault. A notification whose signal is not exported is dropped,
 * counted `(inv_notification_log, dangling_signal_id)`.
 */
export function deviceLocalOf(
  notifications: readonly InvNotificationRow[],
  bindings: readonly ConnectorBindingRow[],
  ctx: Pick<MapContext, "ids" | "count">,
): DeviceLocal {
  const gid = (table: string, id: number) => ctx.ids.resolver.gid(table, String(id));
  const out: DeviceLocal["notifications"][number][] = [];
  for (const n of notifications) {
    const signal = gid("inv_signals", n.signalId);
    if (signal === undefined) {
      ctx.count("inv_notification_log", "dangling_signal_id");
      continue;
    }
    out.push({
      signal,
      severity: n.severity,
      createdAt: n.createdAt,
      sentAt: n.sentAt,
      channel: n.channel,
    });
  }
  const connectorFetch = bindings.flatMap((b) => {
    const binding = gid("connector_bindings", b.id);
    if (binding === undefined) return [];
    return [
      {
        binding,
        lastRunAt: b.lastRunAt,
        lastStatus: b.lastStatus,
        lastOkAt: b.lastOkAt,
        backoffUntil: b.backoffUntil,
      },
    ];
  });
  return { notifications: out, connectorFetch };
}
