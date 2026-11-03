// Research reads over this vault's view (Python `research/service.py` read side, `topic_theses.py`
// getters, `research/signals.py` row helpers): runs and their staleness, notes with the API filters,
// unread marks, research coverage, held / watched / researchable instruments, reference resolution,
// topic theses and the research signals. Every function takes the vault's `Read` (one view database
// per vault, so nothing here can reach another profile) and, where Python read the wall clock, an
// explicit `now` instant.
import { fromIsoCalendar } from "@cashu/domain";
import {
  asProfileId,
  buildSnapshot,
  type CalendarDate,
  type Instrument,
  instrumentLabel,
  research,
} from "@cashu/domain/investments";
import { loadStrategy, type NotificationPolicy } from "@cashu/domain/investments/strategy";
import { loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentRoot, marks, type Read } from "../queries/shared.js";
import { openSignals, type SignalView } from "../queries/signals.js";
import { renames, transactions } from "../queries/transactions.js";
import { byCreation, newestFirst } from "../views/stableOrder.js";
import {
  instantView,
  later,
  NOTE_SQL,
  type NoteRow,
  type ResearchNote,
  type ResearchRun,
  RUN_SQL,
  type RunRow,
  TOPIC_SQL,
  type TopicRow,
  type TopicThesis,
  toNote,
  toRun,
  toTopic,
  viewInstant,
} from "./rows.js";

type Instant = research.Instant;

/** Python `RUN_STALE`: a running run with no note for this long was interrupted. */
export const RUN_STALE = research.hours(4);
/** Python `RESTORE_WINDOW`: dismissals and accepts can be undone this long. */
export const RESTORE_WINDOW =
  BigInt(research.RESEARCH_RESTORE_MINUTES) * 60n * research.MICROS_PER_SECOND;
export const AGENT = "agent";

// ------------------------------------------------------------------ runs

/** Python `run`: the run `gid` of this vault, else undefined. */
export function runByGid(read: Read, gid: string): ResearchRun | undefined {
  const r = read<RunRow>(`${RUN_SQL} WHERE r.gid = ?`, gid)[0];
  return r === undefined ? undefined : toRun(r);
}

/** Python `runs`: newest first. */
export function runs(read: Read, limit = 20): ResearchRun[] {
  const rows = newestFirst(
    read,
    "researchRuns",
    read<RunRow>(RUN_SQL).map(toRun),
    (row) => row.startedAt,
  );
  return limit < 0 ? rows : rows.slice(0, limit);
}

/** Python `latest_run`: the newest run (of `status` when given). */
export function latestRun(read: Read, status?: string): ResearchRun | undefined {
  const rows =
    status === undefined
      ? read<RunRow>(RUN_SQL)
      : read<RunRow>(`${RUN_SQL} WHERE r.status = ?`, status);
  return newestFirst(read, "researchRuns", rows.map(toRun), (row) => row.startedAt)[0];
}

/** Python `_last_activity`: the run's start or its newest note's storing time. */
export function lastActivity(read: Read, run: ResearchRun): Instant {
  const newest = read<{ at: string | null }>(
    `SELECT MAX(n.created_at) AS at FROM research_notes n
     WHERE n.run_id = (SELECT id FROM view_ids WHERE gid = ?)`,
    run.gid,
  )[0]?.at;
  if (newest === null || newest === undefined) return run.startedAt;
  const at = viewInstant(newest);
  return later(at, run.startedAt);
}

/** Python `is_stale`: a running run without a note for `RUN_STALE`. */
export function isStale(read: Read, run: ResearchRun, now: Instant): boolean {
  return run.status === "running" && now - lastActivity(read, run) > RUN_STALE;
}

export interface RunCounts {
  readonly notes: number;
  readonly signals: number;
  readonly candidates: number;
  readonly by_kind: Readonly<Record<string, number>>;
}

/** Python `run_counts`: the run's notes by kind, its candidates and its distinct signal episodes. */
export function runCounts(read: Read, run: ResearchRun): RunCounts {
  const rows = read<{ kind: string; signal: number | null }>(
    `SELECT n.kind,
       COALESCE((SELECT signal_id FROM inv_signal_aliases WHERE id = n.signal_id), n.signal_id) AS signal
     FROM research_notes n WHERE n.run_id = (SELECT id FROM view_ids WHERE gid = ?) ORDER BY n.id`,
    run.gid,
  );
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return {
    notes: rows.length,
    signals: new Set(rows.flatMap((r) => (r.signal === null ? [] : [r.signal]))).size,
    candidates: byKind[research.CANDIDATE_KIND] ?? 0,
    by_kind: byKind,
  };
}

/** The `running` runs, newest first. */
function runningRows(read: Read): ResearchRun[] {
  return newestFirst(
    read,
    "researchRuns",
    read<RunRow>(`${RUN_SQL} WHERE r.status = 'running'`).map(toRun),
    (row) => row.startedAt,
  );
}

/** Python `running_run`: the newest running run that is not stale. */
export function runningRun(read: Read, now: Instant): ResearchRun | undefined {
  return runningRows(read).find((r) => !isStale(read, r, now));
}

/** The running runs that are stale at `now` (Python `_fail_stale_runs` candidates). */
export function staleRuns(read: Read, now: Instant): ResearchRun[] {
  return runningRows(read).filter((r) => isStale(read, r, now));
}

/** Python `is_weekly`: the weekly run covers the held positions. */
export const isWeekly = (run: ResearchRun): boolean => research_truthy(run.scope.held);

/** Python `is_full_refresh`: a full fresh research the owner asked for (P9). */
export const isFullRefresh = (run: ResearchRun): boolean => research_truthy(run.scope.full_refresh);

function research_truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "";
}

/**
 * Python `covered_recently`: instrument gid -> the newest finish of a `done` run that covered it
 * within `days` before `at`.
 */
export function coveredRecently(
  read: Read,
  at: Instant,
  days: number = research.HEALTH_WINDOW_DAYS,
): Map<string, Instant> {
  const since = at - BigInt(days) * research.MICROS_PER_DAY;
  const out = new Map<string, Instant>();
  const rows = read<RunRow>(
    `${RUN_SQL} WHERE r.status = 'done' AND r.started_at >= ?`,
    instantView(since - research.MICROS_PER_DAY),
  ).map(toRun);
  for (const run of rows) {
    const finished = run.finishedAt ?? run.startedAt;
    if (finished < since || finished > at) continue;
    const covered = run.scope.covered_instrument_ids;
    for (const g of Array.isArray(covered) ? covered : []) {
      if (typeof g !== "string") continue;
      const known = out.get(g);
      if (known === undefined || known < finished) out.set(g, finished);
    }
  }
  return out;
}

// ------------------------------------------------------------------ notes

/** Python `note`: the note `gid` of this vault, else undefined. */
export function noteByGid(read: Read, gid: string): ResearchNote | undefined {
  const r = read<NoteRow>(`${NOTE_SQL} WHERE n.gid = ?`, gid)[0];
  return r === undefined ? undefined : toNote(r);
}

/** Notes by gid (unknown gids are absent). */
export function notesByGid(read: Read, gids: readonly string[]): ResearchNote[] {
  if (gids.length === 0) return [];
  return byCreation(
    read,
    "researchNotes",
    read<NoteRow>(`${NOTE_SQL} WHERE n.gid IN (${marks(gids.length)})`, ...gids).map(toNote),
  );
}

/** Raw note rows with an extra SQL condition (internal building block). */
export function noteRows(
  read: Read,
  where: string,
  params: readonly (string | number | null)[] = [],
  order = "n.id",
): ResearchNote[] {
  const rows = read<NoteRow>(`${NOTE_SQL} WHERE ${where} ORDER BY ${order}`, ...params).map(toNote);
  // Genesis creation anchors retain source insertion order; native anchors survive replay.
  // Observation time remains the primary presentation order, independently of created_at.
  return order === "n.id"
    ? byCreation(read, "researchNotes", rows)
    : newestFirst(read, "researchNotes", rows, (row) => row.observedAt);
}

export interface NotesFilter {
  readonly instrument?: string | null;
  readonly theme?: string | null;
  readonly segment?: string | null;
  readonly kinds?: readonly string[] | null;
  /** Storing time at or after this instant (polling while a run is going). */
  readonly since?: Instant | null;
  readonly run?: string | null;
  readonly includeDismissed?: boolean;
  readonly includeExpired?: boolean;
  readonly limit?: number | null;
}

/** Python `notes`: the vault's notes, newest observation first. */
export function notes(read: Read, now: Instant, filter: NotesFilter = {}): ResearchNote[] {
  const where = ["1 = 1"];
  const params: (string | number)[] = [];
  if (filter.instrument !== undefined && filter.instrument !== null) {
    where.push("n.instrument_id = (SELECT id FROM view_ids WHERE gid = ?)");
    params.push(instrumentRoot(read, filter.instrument));
  }
  if (filter.segment !== undefined && filter.segment !== null) {
    where.push("n.segment = ?");
    params.push(filter.segment);
  }
  const kinds = filter.kinds ?? [];
  if (kinds.length > 0) {
    where.push(`n.kind IN (${marks(kinds.length)})`);
    params.push(...kinds);
  }
  if (filter.since !== undefined && filter.since !== null) {
    where.push("n.created_at >= ?");
    params.push(instantView(filter.since));
  }
  if (filter.run !== undefined && filter.run !== null) {
    where.push("n.run_id = (SELECT id FROM view_ids WHERE gid = ?)");
    params.push(filter.run);
  }
  if (!filter.includeDismissed) where.push("n.dismissed_at IS NULL");
  if (!filter.includeExpired) {
    where.push("n.expires_at > ?");
    params.push(instantView(now));
  }
  let rows = noteRows(read, where.join(" AND "), params, "n.observed_at DESC, n.id DESC");
  if (filter.theme !== undefined && filter.theme !== null) {
    const key = research.themeKey(filter.theme);
    rows = rows.filter((r) => r.theme && research.themeKey(r.theme) === key);
  }
  return filter.limit ? rows.slice(0, filter.limit) : rows;
}

/**
 * Python `is_unread`: an agent note (not a candidate) the owner has not opened, still live (not
 * dismissed, not expired).
 */
export function isUnread(n: ResearchNote, now: Instant): boolean {
  return (
    n.readAt === null &&
    n.dismissedAt === null &&
    n.expiresAt > now &&
    n.createdBy === AGENT &&
    n.kind !== research.CANDIDATE_KIND
  );
}

const UNREAD_SQL = `n.read_at IS NULL AND n.dismissed_at IS NULL AND n.expires_at > ?
  AND n.created_by = 'agent' AND n.kind != 'candidate'`;

/** Python `unread_notes`. */
export function unreadNotes(read: Read, now: Instant): ResearchNote[] {
  return noteRows(read, UNREAD_SQL, [instantView(now)]);
}

/** Python `unread_by_instrument`: instrument gid -> number of its unread notes. */
export function unreadByInstrument(read: Read, now: Instant): Map<string, number> {
  const rows = read<{ gid: string; n: number }>(
    `SELECT (SELECT gid FROM view_ids WHERE id = n.instrument_id) AS gid, COUNT(*) AS n
     FROM research_notes n WHERE ${UNREAD_SQL} AND n.instrument_id IS NOT NULL
     GROUP BY n.instrument_id`,
    instantView(now),
  );
  return new Map(rows.map((r) => [r.gid, r.n]));
}

// ------------------------------------------------------------------ instruments

/**
 * Python `owner_named`: an instrument the owner named (claim, other, manually valued without an
 * ISIN): private, never researched (same rule as the MCP privacy layer).
 */
export function ownerNamed(inst: Instrument | undefined): boolean {
  if (inst === undefined) return false;
  return (
    inst.assetClass === "claim" ||
    inst.assetClass === "other" ||
    (inst.valuationMode === "manual" && !inst.isin)
  );
}

/** Python `researchable`. */
export const researchable = (inst: Instrument | undefined): inst is Instrument =>
  inst !== undefined && !ownerNamed(inst) && inst.assetClass !== "cash";

/** Python `held_instrument_ids`: instruments the vault holds on `asOf` (transactions; no valuation). */
export function heldInstrumentGids(read: Read, asOf: CalendarDate): Set<string> {
  const snapshot = buildSnapshot(asProfileId("0"), transactions(read), asOf, {
    renames: renames(read),
  });
  return new Set(snapshot.holdings.map((h) => String(h.instrumentId)));
}

/** Python `_instrument_keys`: symbol, ISIN and alias values, upper-cased. */
export function instrumentKeys(inst: Instrument): Set<string> {
  const keys = new Set<string>();
  for (const k of [inst.symbol, inst.isin]) if (k) keys.add(k.toUpperCase());
  for (const a of inst.aliases) if (a.value) keys.add(a.value.toUpperCase());
  return keys;
}

export type ResolveResult =
  | { readonly ok: true; readonly instrument: string }
  | { readonly ok: false; readonly reason: "no_instrument" | "ambiguous" | "not_researchable" };

/**
 * Python `resolve_reference`: an instrument the vault references, by gid, symbol, ISIN or alias
 * (case-insensitive); owner-named and cash instruments are refused (never researched).
 */
export function resolveReference(read: Read, reference: string): ResolveResult {
  const loaded = loadInstruments(read, vaultInstrumentGids(read));
  const text = reference.trim();
  let matches: string[];
  if (loaded.has(text)) matches = [text];
  else {
    const wanted = text.toUpperCase();
    matches = [...loaded].filter(([, inst]) => instrumentKeys(inst).has(wanted)).map(([g]) => g);
  }
  if (matches.length === 0) return { ok: false, reason: "no_instrument" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const g = matches[0] as string;
  if (!researchable(loaded.get(g))) return { ok: false, reason: "not_researchable" };
  return { ok: true, instrument: g };
}

/** The instrument's display label (Python `inst.label`). */
export const labelOf = (inst: Instrument): string => instrumentLabel(inst);

// ------------------------------------------------------------------ topic theses

/** Python `topic_theses._row`: the stored row of `segment`, a rejection included. */
export function topicThesisRow(read: Read, segment: string): TopicThesis | undefined {
  const r = read<TopicRow>(`${TOPIC_SQL} WHERE t.segment = ?`, segment)[0];
  return r === undefined ? undefined : toTopic(r);
}

/** Python `topic_theses.get`: the live thesis or draft (a rejection reads as undefined). */
export function topicThesis(read: Read, segment: string): TopicThesis | undefined {
  const row = topicThesisRow(read, segment);
  return row === undefined || row.rejectedAt !== null ? undefined : row;
}

/** Python `topic_theses.by_segment`: live theses and drafts per topic. */
export function topicThesesBySegment(read: Read): Map<string, TopicThesis> {
  return new Map(
    read<TopicRow>(`${TOPIC_SQL} WHERE t.rejected_at IS NULL ORDER BY t.id`).map((r) => [
      r.segment,
      toTopic(r),
    ]),
  );
}

/** Python `topic_theses.cooldown_until`. */
export function topicCooldownUntil(row: TopicThesis): Instant | null {
  if (row.rejectedAt === null) return null;
  return row.rejectedAt + BigInt(research.TOPIC_DRAFT_COOLDOWN_DAYS) * research.MICROS_PER_DAY;
}

/** Python `topic_theses.cooldowns`: topic -> until when the agent may not propose a draft. */
export function topicCooldowns(read: Read, now: Instant): Map<string, Instant> {
  const out = new Map<string, Instant>();
  for (const r of read<TopicRow>(`${TOPIC_SQL} WHERE t.rejected_at IS NOT NULL ORDER BY t.id`)) {
    const until = topicCooldownUntil(toTopic(r));
    if (until !== null && until > now) out.set(r.segment, until);
  }
  return out;
}

// ------------------------------------------------------------------ signals

/** Python `open_research_rows`: the open research signals, in fold order. */
export function openResearchSignals(read: Read): SignalView[] {
  return openSignals(read).filter((s) => research.isResearchKey(s.dedupKey));
}

/** Python `_week_notes`: notes stored in the key's ISO week (a day of margin) that map to the key. */
export function weekNoteRows(read: Read, key: string): ResearchNote[] {
  const week = (key.split("|", 1)[0] ?? "").replace(/^research:/, "");
  const [year, number] = week.split("-W");
  const monday = research.utcInstant(fromIsoCalendar(Number(year), Number(number), 1));
  return noteRows(read, "n.created_at >= ? AND n.created_at < ?", [
    instantView(monday - research.MICROS_PER_DAY),
    instantView(monday + 8n * research.MICROS_PER_DAY),
  ]);
}

/**
 * Python `notify_policy`: the severities that notify at once, from the vault's current strategy
 * (the usable config: valid, else partial), else the default (action only).
 */
export function notifyPolicy(read: Read): ReadonlySet<string> {
  const row = read<{ yaml_text: string; md_text: string | null }>(
    "SELECT yaml_text, md_text FROM inv_strategy_versions ORDER BY version DESC LIMIT 1",
  )[0];
  const fallback: NotificationPolicy["immediate"] = new Set(["action"]);
  if (row === undefined) return fallback;
  try {
    const result = loadStrategy(row.yaml_text, row.md_text);
    const config = result.config ?? result.partial;
    return config === null ? fallback : config.notifications.immediate;
  } catch {
    return fallback; // an unreadable strategy falls back to the default policy
  }
}

/** Instrument labels by gid (for views). */
export function labels(read: Read, gids: Iterable<string>): Map<string, string> {
  return new Map([...loadInstruments(read, gids)].map(([g, i]) => [g, labelOf(i)]));
}
