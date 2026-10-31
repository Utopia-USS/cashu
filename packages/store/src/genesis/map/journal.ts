// Genesis row mappers, journal (S26 spec 4.8, D-G7; events.md 8.8): decisions with their signal links
// embedded, theses (the derived change stamps seed the fold), strategy versions in version order and
// planned deposits with their terminal state.
import type {
  InvDecisionRow,
  InvDecisionSignalRow,
  InvPlannedDepositRow,
  InvStrategyVersionRow,
  InvThesisRow,
} from "../invStateRows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

/** Signal ids linked by each decision (`inv_decision_signals`), ascending. */
export function decisionLinks(
  links: readonly InvDecisionSignalRow[],
): ReadonlyMap<number, readonly number[]> {
  const out = new Map<number, number[]>();
  for (const l of links) {
    const own = out.get(l.decisionId);
    if (own === undefined) out.set(l.decisionId, [l.signalId]);
    else own.push(l.signalId);
  }
  for (const ids of out.values()) ids.sort((a, b) => a - b);
  return out;
}

/**
 * `decision.recorded`: `signals` = the decision's `signal_id` first, then its other links by
 * ascending id, each once; dangling ids dropped (counted `dangling_signals`, gid.md 7.6).
 */
export function mapDecision(
  r: InvDecisionRow,
  links: ReadonlyMap<number, readonly number[]>,
  ctx: MapContext,
): RowEvents | undefined {
  const t = "inv_decisions";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const ids = [...(r.signalId === null ? [] : [r.signalId]), ...(links.get(r.id) ?? [])];
  const signals = ctx.rw.refs(t, "signals", "inv_signals", [...new Set(ids)]);
  const data = {
    signals,
    instrument: ctx.rw.ref(t, "instrument_id", "inv_instruments", r.instrumentId),
    account: ctx.rw.ref(t, "account_id", "accounts", r.accountId),
    action: r.action,
    quantity: r.quantity,
    price: r.price,
    currency: r.currency,
    reason: r.reason,
  };
  return rowEvents(t, r.id, [event("decision.recorded", gid, data, stampsOf(r, ["createdAt"]))]);
}

export function mapThesis(r: InvThesisRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "inv_theses", r.id);
  if (gid === undefined) return undefined;
  const data = {
    instrument: requiredGid(ctx, "inv_instruments", r.instrumentId),
    entryType: r.entryType,
    thesis: r.thesis,
    invalidation: r.invalidation,
    exitPlan: r.exitPlan,
    sizePlan: r.sizePlan,
  };
  const stamps = stampsOf(r, [
    "createdAt",
    "updatedAt",
    "reviewedAt",
    "coreChangedAt",
    "exitPlanChangedAt",
  ]);
  return rowEvents("inv_theses", r.id, [event("thesis.created", gid, data, stamps)]);
}

/**
 * `strategy.versionSaved` per version, in version order. Two consecutive versions with one sha256
 * are counted (`strategy_same_sha`): the fold keeps the first (m9).
 */
export function mapStrategyVersions(
  versions: readonly InvStrategyVersionRow[],
  ctx: MapContext,
): RowEvents[] {
  const t = "inv_strategy_versions";
  const ordered = [...versions].sort((a, b) => a.version - b.version || a.id - b.id);
  const out: RowEvents[] = [];
  let previous: string | undefined;
  for (const r of ordered) {
    if (r.sha256 === previous) ctx.count(t, "strategy_same_sha");
    previous = r.sha256;
    const mapped = ctx.attempt(() => {
      const gid = gidOf(ctx, t, r.id);
      if (gid === undefined) return undefined;
      const data = {
        yamlText: r.yamlText,
        mdText: r.mdText,
        sha256: r.sha256,
        state: r.state,
        issues: ctx.rw.json(t, "issues", r.issues),
      };
      return rowEvents(t, r.id, [
        event("strategy.versionSaved", gid, data, stampsOf(r, ["createdAt"])),
      ]);
    });
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/**
 * `plannedDeposit.created`, then `booked` (its transaction gid; a missing or dangling one gives no
 * event, counted `dangling_booked_txn_id`) or `cancelled`.
 */
export function mapPlannedDeposit(r: InvPlannedDepositRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_planned_deposits";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, ["createdAt", "updatedAt", "bookedAt"]);
  const data = {
    account: ctx.rw.ref(t, "account_id", "accounts", r.accountId),
    amount: r.amount,
    currency: r.currency,
    plannedDate: r.plannedDate,
    note: r.note,
  };
  const events = [event("plannedDeposit.created", gid, data, stamps)];
  if (r.status === "booked") {
    const txn =
      r.bookedTxnId === null
        ? null
        : ctx.rw.ref(t, "booked_txn_id", "inv_transactions", r.bookedTxnId);
    if (r.bookedTxnId === null) ctx.count(t, "dangling_booked_txn_id");
    if (txn !== null) events.push(event("plannedDeposit.booked", gid, { txn }, stamps));
  } else if (r.status === "cancelled") {
    events.push(event("plannedDeposit.cancelled", gid, {}, stamps));
  } else if (r.status !== "planned") {
    ctx.count(t, "bad_enum");
    return undefined;
  }
  return rowEvents(t, r.id, events);
}
