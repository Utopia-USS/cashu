// Signals and rule runs (Python `store/signals.py`): open signals, the newest close per dedup key for
// cooldowns, rule runs and the "confirmed by the last good run" check. A signal gid may be an alias
// of an episode (a concurrent open, events.md 8.7): `inv_signal_aliases` maps it to the episode row.

import { byCreation, newestFirst } from "../views/stableOrder.js";
import { gidOf, jsonList, jsonObject, type Read } from "./shared.js";

export const OPEN_STATUSES = ["active", "acknowledged"] as const;
export const CLOSED_STATUSES = ["resolved", "expired"] as const;

export interface SignalView {
  /** The episode's gid (the row the view shows). */
  readonly gid: string;
  readonly ruleId: string;
  readonly kind: string;
  /** The resolved dedup key (gid.md 5). */
  readonly dedupKey: string;
  readonly severity: string;
  readonly polarity: string;
  readonly status: string;
  readonly message: string;
  readonly instrument: string | null;
  readonly account: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdRun: string | null;
  readonly lastRun: string | null;
  readonly acknowledgedAt: string | null;
  readonly closedAt: string | null;
  readonly snoozedUntil: string | null;
}

const SIGNAL_COLUMNS = `s.gid, s.rule_id AS ruleId, s.kind, s.dedup_key AS dedupKey, s.severity,
  s.polarity, s.status, s.message, ${gidOf("s.instrument_id")} AS instrument,
  ${gidOf("s.account_id")} AS account, s.payload, s.first_seen_at AS firstSeenAt,
  s.last_seen_at AS lastSeenAt, ${gidOf("s.created_run_id")} AS createdRun,
  ${gidOf("s.last_run_id")} AS lastRun, s.acknowledged_at AS acknowledgedAt,
  s.closed_at AS closedAt, s.snoozed_until AS snoozedUntil`;

type SignalRow = Omit<SignalView, "payload"> & { payload: string };
const toSignal = (r: SignalRow): SignalView => ({ ...r, payload: jsonObject(r.payload) });

const OPEN_SQL = "s.status IN ('active', 'acknowledged')";

/** Python `open_signal_rows`: the open (active / acknowledged) signals, in fold order. */
export function openSignals(read: Read): SignalView[] {
  return byCreation(
    read,
    "signals",
    read<SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM inv_signals s WHERE ${OPEN_SQL} ORDER BY s.id`,
    ).map(toSignal),
  );
}

/** All current episode rows, including closed history, newest creation anchor first. */
export function allSignals(read: Read): SignalView[] {
  return byCreation(
    read,
    "signals",
    read<SignalRow>(`SELECT ${SIGNAL_COLUMNS} FROM inv_signals s`).map(toSignal),
    true,
  );
}

/** The episode row of signal `gid` (itself or an alias of it), whatever its status. */
export function signalByGid(read: Read, gid: string): SignalView | undefined {
  const r = read<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM inv_signals s
     WHERE s.id = COALESCE((SELECT signal_id FROM inv_signal_aliases WHERE gid = ?),
                           (SELECT id FROM inv_signals WHERE gid = ?))`,
    gid,
    gid,
  )[0];
  return r === undefined ? undefined : toSignal(r);
}

/** The open signal of a (resolved) dedup key, if any (at most one, events.md 8.7). */
export function openSignalOfKey(read: Read, dedupKey: string): SignalView | undefined {
  const r = read<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM inv_signals s WHERE s.dedup_key = ? AND ${OPEN_SQL}`,
    dedupKey,
  )[0];
  return r === undefined ? undefined : toSignal(r);
}

export interface ClosedSignal {
  readonly dedupKey: string;
  /** The newest `closed_at` of the key (stored view timestamp). */
  readonly resolvedAt: string;
}

/**
 * Python `closed_signals`: the newest closed (resolved / expired) signal of each dedup key (for
 * cooldowns). `skipClosedBy`: ignore signals an owner action closed (payload `closed_by`, alerts).
 */
export function closedSignals(
  read: Read,
  options: { skipClosedBy?: boolean } = {},
): ClosedSignal[] {
  const rows = read<{ dedup_key: string; closed_at: string; payload: string }>(
    `SELECT dedup_key, closed_at, payload FROM inv_signals
     WHERE status IN ('resolved', 'expired') AND closed_at IS NOT NULL ORDER BY id`,
  );
  const newest = new Map<string, string>();
  for (const r of rows) {
    if (options.skipClosedBy && jsonObject(r.payload).closed_by) continue;
    const at = newest.get(r.dedup_key);
    if (at === undefined || r.closed_at > at) newest.set(r.dedup_key, r.closed_at);
  }
  return [...newest].map(([dedupKey, resolvedAt]) => ({ dedupKey, resolvedAt }));
}

/** Python `open_alert_signals`: the open signals of alerts, by alert gid. */
export function openAlertSignals(read: Read): Map<string, SignalView> {
  const out = new Map<string, SignalView>();
  for (const r of read<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM inv_signals s WHERE ${OPEN_SQL} AND s.dedup_key LIKE 'alert:%'`,
  )) {
    out.set(r.dedupKey.slice("alert:".length), toSignal(r));
  }
  return out;
}

// ------------------------------------------------------------------ rule runs

export interface RuleRun {
  readonly gid: string;
  readonly trigger: string;
  readonly asOf: string;
  readonly status: string;
  readonly strategyVersion: string | null;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly errors: readonly unknown[];
  readonly report: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

type RunRow = Omit<RuleRun, "stats" | "errors" | "report"> & {
  stats: string;
  errors: string;
  report: string;
};

const toRun = (r: RunRow): RuleRun => ({
  ...r,
  stats: jsonObject(r.stats),
  errors: jsonList(r.errors),
  report: jsonObject(r.report),
});

const RUN_SQL = `SELECT gid, trigger, as_of AS asOf, status,
  ${gidOf("strategy_version_id")} AS strategyVersion, stats, errors, report,
  started_at AS startedAt, finished_at AS finishedAt FROM inv_rule_runs`;

/** Python `runs`: the newest rule runs first (started_at, then fold order). */
export function ruleRuns(read: Read, limit = 20): RuleRun[] {
  const rows = newestFirst(
    read,
    "ruleRuns",
    read<RunRow>(RUN_SQL).map(toRun),
    (row) => row.startedAt,
  );
  return limit < 0 ? rows : rows.slice(0, limit);
}

/** Python `last_run`. */
export function lastRun(read: Read): RuleRun | undefined {
  return ruleRuns(read, 1)[0];
}

export const GOOD_RUN_STATUSES = ["ok", "partial"] as const;

/** Python `last_good_run_id`: the newest run that did not fail (`ok` / `partial`). */
export function lastGoodRunGid(read: Read): string | undefined {
  return newestFirst(
    read,
    "ruleRuns",
    read<{ gid: string; startedAt: string }>(
      `SELECT gid, started_at AS startedAt FROM inv_rule_runs WHERE status IN ('ok', 'partial')`,
    ),
    (row) => row.startedAt,
  )[0]?.gid;
}

/**
 * Python `is_current`: whether the last good run confirmed the signal (true without any good run,
 * for a signal without a run, i.e. research signals, or when its last run is that run).
 */
export function isCurrent(
  signal: Pick<SignalView, "lastRun">,
  goodRun: string | undefined,
): boolean {
  return goodRun === undefined || signal.lastRun === null || signal.lastRun === goodRun;
}
