// The decision journal and position theses (Python `store/journal.py`, read side).

import { compareReadRank, creationRanks, newestFirst, rankOf } from "../views/stableOrder.js";
import { gidOf, instrumentRoot, marks, type Read } from "./shared.js";

export interface DecisionView {
  readonly gid: string;
  /** The first linked signal episode (DERIVED, events.md 8.8). */
  readonly signal: string | null;
  readonly instrument: string | null;
  readonly account: string | null;
  readonly action: string;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

const DECISION_SQL = `SELECT d.gid, ${gidOf("d.signal_id")} AS signal,
  ${gidOf("d.instrument_id")} AS instrument, ${gidOf("d.account_id")} AS account, d.action,
  d.quantity, d.price, d.currency, d.reason, d.created_at AS createdAt FROM inv_decisions d`;

/** Python `decision`: the decision `gid` of this vault (undone ones are gone, TOMB). */
export function decisionByGid(read: Read, gid: string): DecisionView | undefined {
  return read<DecisionView>(`${DECISION_SQL} WHERE d.gid = ?`, gid)[0];
}

/**
 * Python `decisions`: newest first; `signal` keeps those linking that signal (an alias gid finds its
 * episode), `instrument` those of that instrument.
 */
export function decisions(
  read: Read,
  filter: { signal?: string; instrument?: string } = {},
): DecisionView[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.signal !== undefined) {
    where.push(`d.id IN (SELECT l.decision_id FROM inv_decision_signals l WHERE l.signal_id =
      COALESCE((SELECT signal_id FROM inv_signal_aliases WHERE gid = ?),
               (SELECT id FROM inv_signals WHERE gid = ?)))`);
    params.push(filter.signal, filter.signal);
  }
  if (filter.instrument !== undefined) {
    where.push("d.instrument_id = (SELECT id FROM view_ids WHERE gid = ?)");
    params.push(instrumentRoot(read, filter.instrument));
  }
  return newestFirst(
    read,
    "decisions",
    read<DecisionView>(
      `${DECISION_SQL} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY d.created_at DESC, d.id DESC`,
      ...params,
    ),
    (row) => row.createdAt,
  );
}

/**
 * Python `decision_signal_ids`: decision gid -> the signal episodes it links, the first one
 * (`signal_id`) first, then the others in fold order. A decision without signals maps to [].
 */
export function decisionSignalGids(
  read: Read,
  decisionGids: Iterable<string>,
): Map<string, string[]> {
  const ids = [...new Set(decisionGids)];
  const out = new Map<string, string[]>(ids.map((g) => [g, []]));
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = read<{ decision: string; signal: string; first: number }>(
      `SELECT d.gid AS decision, s.gid AS signal, (s.id = d.signal_id) AS first
       FROM inv_decision_signals l JOIN inv_decisions d ON d.id = l.decision_id
       JOIN inv_signals s ON s.id = l.signal_id
       WHERE d.gid IN (${marks(chunk.length)}) ORDER BY first DESC, s.id`,
      ...chunk,
    );
    const ranks = creationRanks(
      read,
      "signals",
      rows.map((row) => row.signal),
    );
    rows.sort(
      (a, b) =>
        b.first - a.first || compareReadRank(rankOf(ranks, a.signal), rankOf(ranks, b.signal)),
    );
    for (const r of rows) out.get(r.decision)?.push(r.signal);
  }
  return out;
}

export interface ThesisView {
  readonly gid: string;
  readonly instrument: string;
  readonly entryType: string;
  readonly thesis: string;
  readonly invalidation: string | null;
  readonly exitPlan: string | null;
  readonly sizePlan: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly coreChangedAt: string | null;
  readonly exitPlanChangedAt: string | null;
}

const THESIS_SQL = `SELECT t.gid, ${gidOf("t.instrument_id")} AS instrument, t.entry_type AS entryType,
  t.thesis, t.invalidation, t.exit_plan AS exitPlan, t.size_plan AS sizePlan,
  t.reviewed_at AS reviewedAt, t.created_at AS createdAt, t.updated_at AS updatedAt,
  t.core_changed_at AS coreChangedAt, t.exit_plan_changed_at AS exitPlanChangedAt FROM inv_theses t`;

/** Python `theses`: newest first; `instrument` keeps that instrument's (members resolve). */
export function theses(read: Read, instrument?: string): ThesisView[] {
  if (instrument === undefined) {
    return newestFirst(read, "theses", read<ThesisView>(THESIS_SQL), (row) => row.createdAt);
  }
  return newestFirst(
    read,
    "theses",
    read<ThesisView>(
      `${THESIS_SQL} WHERE t.instrument_id = (SELECT id FROM view_ids WHERE gid = ?)
     ORDER BY t.created_at DESC, t.id DESC`,
      instrumentRoot(read, instrument),
    ),
    (row) => row.createdAt,
  );
}

/** Python `thesis`: the thesis `gid` of this vault (deleted ones are gone, TOMB). */
export function thesisByGid(read: Read, gid: string): ThesisView | undefined {
  return read<ThesisView>(`${THESIS_SQL} WHERE t.gid = ?`, gid)[0];
}
