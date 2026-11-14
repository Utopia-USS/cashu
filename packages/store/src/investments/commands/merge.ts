// Merging two instruments that are the same security (Python `store/instrument_merge.py`). In the
// event store a merge is ONE `instrument.merged {source, target}` (an IDENTITY merge, events.md 6.4):
// the fold re-keys every row that references either gid onto the target's root, collapses rows that
// now share a row key and drops renames between the two. Field precedence on collapsed rows is the
// table's rule over the merged stream (lead decision R-2), not Python's target-first rules (R-S5):
// e.g. the newest override write wins instead of the target's. Market identity: the target keeps its
// symbol / ISIN / MIC and takes the source's when it has none (D-S5).
//
// The checks run against this vault's view before anything is written; `mergePreview` is the
// dry run (Python `dry_run=True`) and reports how many rows reference the source.
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { gid } from "../../events/v1/primitives.js";
import { instrumentRoot, type Read } from "../queries/shared.js";

/** Tables (and FK columns) whose rows move with a merge, as Python's report names them. */
const REFERENCES: readonly (readonly [string, string])[] = [
  ["inv_instrument_aliases", "instrument_id"],
  ["inv_transactions", "instrument_id"],
  ["inv_position_snapshots", "instrument_id"],
  ["inv_instrument_renames", "old_instrument_id"],
  ["inv_instrument_renames", "new_instrument_id"],
  ["inv_manual_valuations", "instrument_id"],
  ["inv_profile_instruments", "instrument_id"],
  ["watchlist_items", "instrument_id"],
  ["inv_theses", "instrument_id"],
  ["inv_signals", "instrument_id"],
  ["inv_decisions", "instrument_id"],
  ["alerts", "instrument_id"],
  ["research_notes", "instrument_id"],
];

export type MergeRefusal =
  | "same_instrument"
  | "no_instrument"
  | "different_currency"
  | "different_isin";

export interface MergePlan {
  readonly source: string;
  readonly target: string;
  readonly sourceName: string;
  readonly targetName: string;
  /** Rows referencing the source, per `table.column` (only non-zero entries). */
  readonly moved: Readonly<Record<string, number>>;
}

interface Row {
  id: number;
  gid: string;
  name: string;
  currency: string;
  isin: string | null;
}

/**
 * Python `merge_instruments(dry_run=True)`: the refusal, or what a merge of `source` into `target`
 * would move. Members resolve to their roots; two members of one root are the same instrument.
 */
export function mergePreview(
  read: Read,
  source: string,
  target: string,
):
  | { readonly ok: true; readonly plan: MergePlan }
  | { readonly ok: false; readonly reason: MergeRefusal } {
  const s = instrumentRoot(read, source);
  const t = instrumentRoot(read, target);
  if (s === t) return { ok: false, reason: "same_instrument" };
  const row = (g: string) =>
    read<Row>("SELECT id, gid, name, currency, isin FROM inv_instruments WHERE gid = ?", g)[0];
  const src = row(s);
  const tgt = row(t);
  if (src === undefined || tgt === undefined) return { ok: false, reason: "no_instrument" };
  if (src.currency.toUpperCase() !== tgt.currency.toUpperCase()) {
    return { ok: false, reason: "different_currency" };
  }
  if (src.isin && tgt.isin && src.isin.toUpperCase() !== tgt.isin.toUpperCase()) {
    return { ok: false, reason: "different_isin" };
  }
  const moved: Record<string, number> = {};
  for (const [table, column] of REFERENCES) {
    const n =
      read<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, src.id)[0]?.n ??
      0;
    if (n > 0) moved[`${table}.${column}`] = n;
  }
  return {
    ok: true,
    plan: { source: s, target: t, sourceName: src.name, targetName: tgt.name, moved },
  };
}

export const mergeInstruments = defineCommand({
  id: "investments.mergeInstruments",
  input: z.object({ source: gid, target: gid }),
  /** The owner's merge: `instrument.merged` (gid = the source root) after `mergePreview`'s checks. */
  run(ctx, input) {
    const preview = mergePreview(ctx.read, input.source, input.target);
    if (!preview.ok) return refuse(preview.reason);
    const { source, target } = preview.plan;
    ctx.emit("instrument.merged", source, { source, target, reason: "owner" });
    return ok(preview.plan);
  },
});
