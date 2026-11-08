// The decision journal and position theses (Python `store/journal.py`, write side). A decision links
// signal episodes; acknowledging them is DERIVED in the fold (events.md 6.5), so the command emits
// only `decision.recorded`, and an undo only `decision.undone` (TOMB): the fold returns the episodes
// to active unless another live decision still links them.
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { DECISION_ACTIONS, THESIS_ENTRY_TYPES } from "../../events/v1/journal.js";
import { assetCurrency, decimal, gid } from "../../events/v1/primitives.js";
import { decisionByGid, decisionSignalGids, thesisByGid } from "../queries/journal.js";
import { instrumentGid } from "../queries/shared.js";
import { type SignalView, signalByGid } from "../queries/signals.js";

/** Python `UNDO_WINDOW`: how long after recording a decision it can still be undone. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

const viewMs = (view: string) => Date.parse(`${view.slice(0, 10)}T${view.slice(11, 23)}Z`);

export const recordDecision = defineCommand({
  id: "investments.recordDecision",
  input: z.object({
    action: z.enum(DECISION_ACTIONS),
    signals: z.array(gid).default([]),
    instrument: gid.nullable().default(null),
    account: gid.nullable().default(null),
    quantity: decimal.nullable().default(null),
    price: decimal.nullable().default(null),
    currency: z.string().nullable().default(null),
    reason: z.string().nullable().default(null),
  }),
  /**
   * Python `record_decision`: a journal entry, linked to signals of one instrument (each once; an
   * alias gid counts as its episode). The instrument defaults to the signals', the account to theirs
   * when they all share one. It never books a transaction.
   */
  run(ctx, input) {
    if (input.quantity?.startsWith("-")) return refuse("negative_quantity");
    if (input.price?.startsWith("-")) return refuse("negative_price");
    const rows: SignalView[] = [];
    for (const g of input.signals) {
      const s = signalByGid(ctx.read, g);
      if (s === undefined) return refuse("no_signal"); // another vault's, or not held yet
      if (!rows.some((r) => r.gid === s.gid)) rows.push(s);
    }
    if (new Set(rows.map((r) => r.instrument)).size > 1) return refuse("mixed_instruments");
    let instrument: string | null = null;
    if (input.instrument !== null) {
      const root = instrumentGid(ctx.read, input.instrument);
      if (root === undefined) return refuse("no_instrument");
      instrument = root;
    }
    const first = rows[0];
    if (
      first !== undefined &&
      instrument !== null &&
      ![null, instrument].includes(first.instrument)
    ) {
      return refuse("other_instrument");
    }
    let account = input.account;
    if (first !== undefined) {
      instrument ??= first.instrument;
      if (account === null && new Set(rows.map((r) => r.account)).size === 1)
        account = first.account;
    }
    const currency = input.currency ? input.currency.toUpperCase() : null;
    if (currency !== null && !assetCurrency.safeParse(currency).success) {
      return refuse("invalid_currency");
    }
    const decision = ctx.newGid();
    ctx.emit("decision.recorded", decision, {
      signals: rows.map((r) => r.gid),
      instrument,
      account,
      action: input.action,
      quantity: input.quantity,
      price: input.price,
      currency,
      reason: input.reason?.trim() || null,
    });
    return ok({ decision, signals: rows.map((r) => r.gid) });
  },
});

export const undoDecision = defineCommand({
  id: "investments.undoDecision",
  input: z.object({ decision: gid }),
  /**
   * Python `undo_decision`: within UNDO_WINDOW of recording (checked at emit time, events.md 6.3).
   * Returns the linked signal episodes, the first one first.
   */
  run(ctx, input) {
    const d = decisionByGid(ctx.read, input.decision);
    if (d === undefined) return refuse("no_decision");
    if (Date.parse(ctx.now()) - viewMs(d.createdAt) > UNDO_WINDOW_MS) {
      return refuse("undo_expired");
    }
    const signals = decisionSignalGids(ctx.read, [d.gid]).get(d.gid) ?? [];
    ctx.emit("decision.undone", d.gid, {});
    return ok({ signals });
  },
});

// ------------------------------------------------------------------ theses

const thesisValues = {
  entryType: z.string().optional(),
  thesis: z.string().nullable().optional(),
  invalidation: z.string().nullable().optional(),
  exitPlan: z.string().nullable().optional(),
  sizePlan: z.string().nullable().optional(),
};
type ThesisValues = { [K in keyof typeof thesisValues]?: string | null };
const FIELDS = ["entryType", "thesis", "invalidation", "exitPlan", "sizePlan"] as const;

/**
 * Python `_clean_thesis`: strip, empty -> null; `entryType` must be a known type and `thesis` set
 * (when present, or always for a full write).
 */
function cleanThesis(
  values: ThesisValues,
  partial: boolean,
): { ok: true; values: Record<string, string | null> } | { ok: false; reason: string } {
  const out: Record<string, string | null> = {};
  for (const key of FIELDS) {
    if (!(key in values) || values[key] === undefined) continue;
    const v = values[key];
    out[key] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  const types: readonly string[] = THESIS_ENTRY_TYPES;
  if (("entryType" in out || !partial) && !types.includes(out.entryType ?? "")) {
    return { ok: false, reason: "invalid_entry_type" };
  }
  if (("thesis" in out || !partial) && !out.thesis) return { ok: false, reason: "thesis_required" };
  return { ok: true, values: out };
}

export const createThesis = defineCommand({
  id: "investments.createThesis",
  input: z.object({ instrument: gid, ...thesisValues }),
  /** Python `create_thesis` (the fold derives `core_changed_at` / `exit_plan_changed_at`, 8.8). */
  run(ctx, input) {
    const cleaned = cleanThesis(input, false);
    if (!cleaned.ok) return refuse(cleaned.reason);
    const root = instrumentGid(ctx.read, input.instrument);
    if (root === undefined) return refuse("no_instrument");
    const thesis = ctx.newGid();
    const v = cleaned.values;
    ctx.emit("thesis.created", thesis, {
      instrument: root,
      entryType: v.entryType,
      thesis: v.thesis,
      invalidation: v.invalidation ?? null,
      exitPlan: v.exitPlan ?? null,
      sizePlan: v.sizePlan ?? null,
    });
    return ok({ thesis });
  },
});

export const updateThesis = defineCommand({
  id: "investments.updateThesis",
  input: z.object({
    id: gid,
    values: z.object(thesisValues),
    reviewed: z.boolean().default(false),
  }),
  /**
   * Python `update_thesis`: the present fields, cleaned; `reviewed` stamps `reviewed_at`. A call that
   * sets nothing and is not a review writes nothing (Python still bumped `updated_at`).
   */
  run(ctx, input) {
    if (thesisByGid(ctx.read, input.id) === undefined) return refuse("no_thesis");
    const cleaned = cleanThesis(input.values, true);
    if (!cleaned.ok) return refuse(cleaned.reason);
    const patch: Record<string, unknown> = { ...cleaned.values };
    if (input.reviewed) patch.reviewed = true;
    if (Object.keys(patch).length > 0) ctx.emit("thesis.updated", input.id, patch);
    return ok({ thesis: input.id });
  },
});
