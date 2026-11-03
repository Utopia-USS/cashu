// Research commands (Python `research/service.py` write side): start / finish runs, add a note
// (validated, sourced, linked to an instrument, a market segment, an (old) theme or a candidate;
// duplicate, near-duplicate, one-note-per-segment-and-week and the weekly run's novelty limits),
// read marks, dismiss / restore (the research signal follows) and the leader's housekeeping.
//
// Refusals are value-free codes (`RESEARCH_REFUSALS` maps each to Python's error class: 422
// `research_invalid`, 409 `research_conflict` / `undo_expired`, 404 not found). The MCP and API
// layers that need Python's issue texts run `research.validateNote` / `validateScope` themselves
// first; the command validates again at the trust boundary.
//
// Decisions (S21b):
// - A stale run (running, no note for 4 hours) is closed `failed {reason: interrupted}` in the batch
//   of the next start / note on any device (Python `_fail_stale_runs`), and by the leader's
//   housekeeping; until then readers treat it as failed (`isStale`).
// - `notes_expired` resolves (housekeeping, also after a finish) come from the lease holder only
//   (events.md 8.7); a finish on another device leaves them to the leader's daily housekeeping.
// - Candidate keys of an instrument candidate fall back to the instrument gid (Python `str(id)`).

import { pyCasefold } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { research } from "@cashu/domain/investments";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { gid } from "../../events/v1/primitives.js";
import { watchedInstrumentGids } from "../queries/alerts.js";
import { loadInstrument, loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import {
  AGENT,
  heldInstrumentGids,
  instrumentKeys,
  isFullRefresh,
  isStale,
  isUnread,
  isWeekly,
  lastActivity,
  noteByGid,
  noteRows,
  notes,
  notifyPolicy,
  openResearchSignals,
  RESTORE_WINDOW,
  researchable,
  resolveReference,
  runByGid,
  runCounts,
  runningRun,
  staleRuns,
  topicThesis,
  weekNoteRows,
} from "./queries.js";
import {
  eventInstant,
  hasBrief,
  instantEvent,
  instantView,
  type ResearchNote,
  type ResearchRun,
  signalRecord,
  truthy,
} from "./rows.js";
import { NO_SYNC, reopenDismissed, type SyncResult, syncResearchSignal } from "./sync.js";

type Instant = research.Instant;

/** Python `MAX_NOTES_PER_RUN`. */
export const MAX_NOTES_PER_RUN = 150;
/** Python `DUPLICATE_WINDOW` (days). */
export const DUPLICATE_WINDOW_DAYS = 14;
export const WEEKLY_INSTRUMENTS_MAX = 6;
export const WEEKLY_NOTES_PER_INSTRUMENT = 2;
export const WEEKLY_SEGMENT_NOTES_MAX = 6;
export const NOVELTY_EXEMPT_RELATIONS: readonly string[] = ["invalidates", "fulfills"];
/** Python `MAX_READ_IDS`. */
export const MAX_READ_IDS = 500;
const CANDIDATE_COOLDOWN =
  BigInt(research.RESEARCH_CANDIDATE_COOLDOWN_DAYS) * research.MICROS_PER_DAY;

/** Refusal code -> Python error class (`invalid` 422, `conflict` / `undo_expired` 409, `not_found` 404). */
export const RESEARCH_REFUSALS = {
  invalid_scope: "invalid",
  invalid_note: "invalid",
  invalid_counts: "invalid",
  invalid_status: "invalid",
  reason_too_long: "invalid",
  ambiguous: "invalid",
  not_researchable: "invalid",
  segment_only: "invalid",
  no_scope: "invalid",
  candidate_without_instrument: "invalid",
  topic_without_thesis: "invalid",
  topic_thesis_draft: "invalid",
  relation_needs_thesis: "invalid",
  instrument_without_thesis: "invalid",
  bad_selector: "invalid",
  unknown_segment: "invalid",
  empty_theme: "invalid",
  bad_ids: "invalid",
  candidate_without_symbol: "invalid",
  unresolved_instrument: "invalid",
  invalid_segment: "invalid",
  macro_segment: "invalid",
  invalid_thesis: "invalid",
  invalid_view: "invalid",
  topic_needs_thesis: "invalid",
  run_running: "conflict",
  not_candidate: "conflict",
  candidate_dismissed: "conflict",
  candidate_accepted: "conflict",
  not_accepted: "conflict",
  watchlist_full: "invalid",
  owner_thesis: "conflict",
  rejected_draft: "conflict",
  not_leader: "conflict",
  run_not_running: "conflict",
  run_full: "conflict",
  candidate_held: "conflict",
  candidate_cooldown: "conflict",
  candidate_proposed: "conflict",
  duplicate: "conflict",
  duplicate_dismissed: "conflict",
  segment_week: "conflict",
  segment_week_brief: "conflict",
  near_duplicate: "conflict",
  novelty_segments: "conflict",
  novelty_instruments: "conflict",
  novelty_per_instrument: "conflict",
  undo_expired: "undo_expired",
  no_run: "not_found",
  no_note: "not_found",
  no_instrument: "not_found",
} as const;

export type ResearchRefusal = keyof typeof RESEARCH_REFUSALS;

const LANGS = ["pl", "en"] as const;
const jsonRecord = z.record(z.string(), z.unknown());

/** The command's clock as an instant (ms precision, UTC). */
export const nowOf = (ctx: CommandContext): Instant => eventInstant(ctx.now());

// ------------------------------------------------------------------ runs

/**
 * Python `_fail_stale_runs`: running runs without a note for 4 hours are closed `failed` with the
 * server counts and `reason: interrupted`, `finished_at` = their last activity. Returns their gids.
 */
export function failStaleRuns(ctx: CommandContext, now: Instant): Set<string> {
  const failed = new Set<string>();
  for (const run of staleRuns(ctx.read, now)) {
    ctx.emit("researchRun.finished", run.gid, {
      status: "failed",
      counts: { ...runCounts(ctx.read, run), ...run.counts, reason: "interrupted" },
      stamps: { finished_at: instantEvent(lastActivity(ctx.read, run)) },
    });
    failed.add(run.gid);
  }
  return failed;
}

export const startResearchRun = defineCommand({
  id: "investments.research.startRun",
  input: z.object({
    scope: jsonRecord.nullable().default(null),
    createdBy: z.enum(research.RESEARCH_CREATORS as ["agent", "user"]).default("agent"),
  }),
  /**
   * Python `start_run`: another non-stale running run is a conflict; stale ones close as failed.
   * The scope lists the covered instruments (explicit + held / watched researchable ones as asked).
   */
  run(ctx, input) {
    let scope: research.RunScope;
    try {
      scope = research.validateScope(input.scope);
    } catch (e) {
      if (e instanceof research.ResearchInputError) return refuse("invalid_scope");
      throw e;
    }
    const now = nowOf(ctx);
    const failed = failStaleRuns(ctx, now);
    const current = runningRun(ctx.read, now);
    if (current !== undefined && !failed.has(current.gid)) return refuse("run_running");
    const explicit: string[] = [];
    for (const ref of scope.instruments) {
      const r = resolveReference(ctx.read, ref);
      if (!r.ok) return refuse(r.reason);
      explicit.push(r.instrument);
    }
    const covered = new Set(explicit);
    const wanted = new Set<string>();
    if (scope.held) for (const g of heldInstrumentGids(ctx.read, ctx.today())) wanted.add(g);
    if (scope.watchlist) for (const g of watchedInstrumentGids(ctx.read)) wanted.add(g);
    for (const [g, inst] of loadInstruments(ctx.read, wanted))
      if (researchable(inst)) covered.add(g);
    const run = ctx.newGid();
    ctx.emit("researchRun.started", run, {
      scope: {
        held: scope.held,
        watchlist: scope.watchlist,
        candidates: scope.candidates,
        themes: [...scope.themes],
        segments: [...scope.segments],
        instrument_ids: explicit,
        covered_instrument_ids: [...covered].sort(),
        scheduled: scope.scheduled,
        full_refresh: scope.fullRefresh,
      },
      createdBy: input.createdBy,
      stamps: { started_at: instantEvent(now) },
    });
    return ok({ run });
  },
});

export const finishResearchRun = defineCommand({
  id: "investments.research.finishRun",
  input: z.object({
    run: gid,
    status: z.string().default("done"),
    counts: jsonRecord.nullable().default(null),
    reason: z.string().nullable().default(null),
    lang: z.enum(LANGS).default("pl"),
  }),
  /**
   * Python `finish_run`: close a running run as done / failed with the agent's counters (validated)
   * under the server's; the leader then runs the housekeeping.
   */
  run(ctx, input) {
    const now = nowOf(ctx);
    const run = runByGid(ctx.read, input.run);
    if (run === undefined) return refuse("no_run");
    if (input.status !== "done" && input.status !== "failed") return refuse("invalid_status");
    if (run.status !== "running") return refuse("run_not_running");
    let agent: Record<string, number>;
    try {
      agent = research.validateCounts(input.counts);
    } catch (e) {
      if (e instanceof research.ResearchInputError) return refuse("invalid_counts");
      throw e;
    }
    const text = input.reason?.trim() || null;
    if (text !== null && [...text].length > research.REASON_MAX) return refuse("reason_too_long");
    const counts: Record<string, unknown> = { ...agent, ...runCounts(ctx.read, run) };
    if (text !== null) counts.reason = text;
    ctx.emit("researchRun.finished", run.gid, {
      status: input.status,
      counts,
      stamps: { finished_at: instantEvent(now) },
    });
    const housekeeping = ctx.lease.isHolder()
      ? housekeep(ctx, now, input.lang, new Set([run.gid]))
      : undefined;
    return ok({ run: run.gid, housekeeping });
  },
});

// ------------------------------------------------------------------ notes

/** Python `_stored_theme`: the spelling of `theme` already used in the vault. */
function storedTheme(ctx: CommandContext, theme: string | null): string | null {
  const text = research.cleanTheme(theme);
  if (text === null) return null;
  const key = research.themeKey(text);
  for (const row of ctx.read<{ theme: string }>(
    "SELECT theme FROM research_notes WHERE theme IS NOT NULL ORDER BY id",
  )) {
    if (row.theme && research.themeKey(row.theme) === key) return row.theme;
  }
  return text;
}

const days = (n: number) => BigInt(n) * research.MICROS_PER_DAY;

/** Python `_duplicate`: same scope, same title or first source, within 14 days, dismissed included. */
function duplicateOf(
  ctx: CommandContext,
  data: research.NoteInput,
  instrument: string | null,
  theme: string | null,
  candidateKey: string | null,
  now: Instant,
): ResearchNote | undefined {
  const firstUrl = data.sources[0]?.url ?? null;
  const title = pyCasefold(data.title);
  const tkey = theme ? research.themeKey(theme) : null;
  const rows = noteRows(ctx.read, "n.created_at >= ?", [
    instantView(now - days(DUPLICATE_WINDOW_DAYS)),
  ]);
  return rows.find((row) => {
    const sameScope =
      (instrument !== null && row.instrument === instrument) ||
      (instrument === null && candidateKey !== null && row.candidateKey === candidateKey) ||
      (instrument === null &&
        candidateKey === null &&
        data.segment !== null &&
        row.instrument === null &&
        row.segment === data.segment) ||
      (instrument === null &&
        candidateKey === null &&
        data.segment === null &&
        tkey !== null &&
        row.instrument === null &&
        row.theme !== null &&
        research.themeKey(row.theme) === tkey);
    if (!sameScope) return false;
    const urls = new Set(
      row.sources.map((s) =>
        typeof s === "object" && s !== null ? (s as Record<string, unknown>).url : undefined,
      ),
    );
    return pyCasefold(row.title) === title || (firstUrl !== null && urls.has(firstUrl));
  });
}

function briefOf(details: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  const brief = details?.brief;
  return typeof brief === "object" && brief !== null && !Array.isArray(brief)
    ? (brief as Record<string, unknown>)
    : {};
}

const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function fingerprintOf(
  title: string,
  summary: string,
  details: Readonly<Record<string, unknown>> | null,
  polarity: string,
  relation: string,
): research.similarity.Fingerprint {
  const brief = briefOf(details);
  return research.similarity.fingerprint(title, summary, textOrNull(brief.headline) || null, {
    why: textOrNull(brief.why),
    polarity,
    relation,
  });
}

/** Python `_near_duplicate`: a live note of the same scope stating the same fact in other words. */
function nearDuplicateOf(
  ctx: CommandContext,
  data: research.NoteInput,
  instrument: string | null,
  candidateKey: string | null,
  now: Instant,
): ResearchNote | null {
  const where = ["n.dismissed_at IS NULL", "n.observed_at >= ?"];
  const params: string[] = [instantView(now - days(research.similarity.WINDOW_DAYS))];
  if (instrument !== null) {
    where.push("n.instrument_id = (SELECT id FROM view_ids WHERE gid = ?)");
    params.push(instrument);
  } else if (candidateKey !== null) {
    where.push("n.candidate_key = ?");
    params.push(candidateKey);
  } else if (data.segment !== null) {
    where.push("n.segment = ? AND n.instrument_id IS NULL");
    params.push(data.segment);
  } else {
    return null;
  }
  const rows = noteRows(ctx.read, where.join(" AND "), params, "n.observed_at DESC, n.id DESC");
  if (rows.length === 0) return null;
  const next = fingerprintOf(
    data.title,
    data.summary,
    data.details,
    data.polarity,
    data.thesisRelation,
  );
  return research.similarity.firstNearDuplicate(
    next,
    rows.map(
      (r) =>
        [r, fingerprintOf(r.title, r.summary, r.details, r.polarity, r.thesisRelation)] as const,
    ),
  );
}

/** Monday 00:00 UTC of the ISO week of `day` (Python `_week_start`). */
const weekStartAt = (day: string): Instant => research.utcInstant(research.weekStart(day));

/**
 * Python `_segment_week_note`: a note of `segment` observed in the ISO week of `observed` or stored
 * in the ISO week of `now` (dismissed included); brief notes and other notes are counted apart.
 */
function segmentWeekNote(
  ctx: CommandContext,
  segment: string,
  observed: Instant,
  now: Instant,
  brief: boolean,
): ResearchNote | undefined {
  const observedDay = research.instantDate(observed);
  const storedDay = research.instantDate(now);
  const observedWeek = research.isoWeek(observedDay);
  const storedWeek = research.isoWeek(storedDay);
  const observedFrom = weekStartAt(observedDay);
  const storedFrom = weekStartAt(storedDay);
  const rows = noteRows(
    ctx.read,
    "n.segment = ? AND ((n.observed_at >= ? AND n.observed_at < ?) OR n.created_at >= ?)",
    [
      segment,
      instantView(observedFrom - days(1)),
      instantView(observedFrom + days(8)),
      instantView(storedFrom - days(1)),
    ],
  );
  return rows.find(
    (row) =>
      hasBrief(row.details) === brief &&
      (research.isoWeek(research.instantDate(row.observedAt)) === observedWeek ||
        research.isoWeek(research.instantDate(row.createdAt)) === storedWeek),
  );
}

/** Python `_novelty_rows`: this ISO week's notes of weekly runs and of the agent without a run. */
function noveltyRows(ctx: CommandContext, now: Instant): ResearchNote[] {
  const since = weekStartAt(research.instantDate(now));
  const rows = noteRows(ctx.read, "n.created_at >= ?", [instantView(since)]);
  const weekly = new Set<string>();
  for (const g of new Set(rows.flatMap((r) => (r.run === null ? [] : [r.run])))) {
    const run = runByGid(ctx.read, g);
    if (run !== undefined && isWeekly(run)) weekly.add(g);
  }
  return rows.filter(
    (r) => (r.run !== null && weekly.has(r.run)) || (r.run === null && r.createdBy === AGENT),
  );
}

/** Python `_check_novelty`: the weekly novelty limits (P5); returns a refusal code or null. */
function noveltyProblem(
  ctx: CommandContext,
  data: research.NoteInput,
  instrument: string | null,
  now: Instant,
): ResearchRefusal | null {
  if (data.segment === null && (instrument === null || data.kind === research.CANDIDATE_KIND)) {
    return null;
  }
  const rows = noveltyRows(ctx, now);
  if (data.segment !== null) {
    if (NOVELTY_EXEMPT_RELATIONS.includes(data.thesisRelation)) return null;
    if (rows.filter((r) => r.segment !== null).length >= WEEKLY_SEGMENT_NOTES_MAX) {
      return "novelty_segments";
    }
    return null;
  }
  if (data.strength >= 3 || NOVELTY_EXEMPT_RELATIONS.includes(data.thesisRelation)) return null;
  const own = rows.filter((r) => r.instrument !== null && r.kind !== research.CANDIDATE_KIND);
  const covered = new Set(own.map((r) => r.instrument));
  if (!covered.has(instrument) && covered.size >= WEEKLY_INSTRUMENTS_MAX) {
    return "novelty_instruments";
  }
  if (own.filter((r) => r.instrument === instrument).length >= WEEKLY_NOTES_PER_INSTRUMENT) {
    return "novelty_per_instrument";
  }
  return null;
}

/** Python `_candidate_profile_match`: a held / watched instrument whose keys name `key`. */
function candidateMatch(ctx: CommandContext, key: string, owned: ReadonlySet<string>): boolean {
  const bare = key.split(".")[0]?.split(":")[0] ?? "";
  for (const inst of loadInstruments(ctx.read, owned).values()) {
    if (instrumentKeys(inst).has(key) || (inst.symbol && inst.symbol.toUpperCase() === bare)) {
      return true;
    }
  }
  return false;
}

export interface AddedNote {
  readonly note: string;
  readonly signal: SyncResult | null;
  /** Value-free warning codes (`not_held_or_watched`: the instrument only carries an alert). */
  readonly warnings: readonly string[];
}

/** Prospective row hook for same-batch derived checks; default standalone behavior is unchanged. */
export function researchNoteCommand(afterAdded?: (ctx: CommandContext, row: ResearchNote) => void) {
  return defineCommand({
    id: "investments.research.addNote",
    input: z.object({
      /** The raw note (MCP / API arguments); validated here with `research.validateNote`. */
      note: jsonRecord,
      /** An instrument reference: gid, symbol, ISIN or alias (Python `resolve_reference`). */
      instrument: z.string().nullable().default(null),
      run: gid.nullable().default(null),
      createdBy: z.enum(research.RESEARCH_CREATORS as ["agent", "user"]).default("agent"),
      lang: z.enum(LANGS).default("pl"),
    }),
    /**
     * Python `add_note` (after `validate_note` and `resolve_reference`): the run, the per-run limit,
     * the scope, the thesis relation, candidate rules, duplicates, one segment note per segment and
     * ISO week, near duplicates and the weekly novelty limits; a qualifying note creates or joins the
     * research signal of its instrument / segment / theme and week.
     */
    run(ctx, input) {
      const now = nowOf(ctx);
      let data: research.NoteInput;
      try {
        data = research.validateNote(input.note, now);
      } catch (e) {
        if (e instanceof research.ResearchInputError) return refuse("invalid_note");
        throw e;
      }
      let instrument: string | null = null;
      if (input.instrument !== null) {
        const r = resolveReference(ctx.read, input.instrument);
        if (!r.ok) return refuse(r.reason);
        instrument = r.instrument;
      }
      const failed = failStaleRuns(ctx, now);
      let run: ResearchRun | undefined;
      if (input.run !== null) {
        run = runByGid(ctx.read, input.run);
        if (run === undefined) return refuse("no_run");
        if (run.status !== "running" || failed.has(run.gid)) return refuse("run_not_running");
      } else {
        run = runningRun(ctx.read, now);
      }
      if (run !== undefined) {
        const stored =
          ctx.read<{ n: number }>(
            "SELECT COUNT(*) AS n FROM research_notes WHERE run_id = (SELECT id FROM view_ids WHERE gid = ?)",
            run.gid,
          )[0]?.n ?? 0;
        if (stored >= MAX_NOTES_PER_RUN) return refuse("run_full");
      }
      const theme = storedTheme(ctx, data.theme);
      if (
        data.segment !== null &&
        (instrument !== null || data.candidate !== null || data.kind === research.CANDIDATE_KIND)
      ) {
        return refuse("segment_only");
      }
      const held = heldInstrumentGids(ctx.read, ctx.today());
      const watched = watchedInstrumentGids(ctx.read);
      const owned = new Set([...held, ...watched]);
      let candidateKey: string | null = null;
      const details: Record<string, unknown> = { ...(data.details ?? {}) };
      if (data.kind === research.CANDIDATE_KIND) {
        if (instrument !== null) {
          if (owned.has(instrument)) return refuse("candidate_held");
          const inst = loadInstrument(ctx.read, instrument);
          candidateKey = ((inst ? inst.isin || inst.symbol : null) || instrument).toUpperCase();
        } else if (data.candidate !== null) {
          candidateKey = research.candidateKey(data.candidate);
          if (candidateMatch(ctx, candidateKey, owned)) return refuse("candidate_held");
        } else {
          return refuse("candidate_without_instrument");
        }
        const key = candidateKey;
        const blocked = noteRows(ctx.read, "n.kind = 'candidate' AND n.cooldown_until > ?", [
          instantView(now),
        ]).find(
          (r) =>
            (key && r.candidateKey === key) || (instrument !== null && r.instrument === instrument),
        );
        if (blocked !== undefined) return refuse("candidate_cooldown");
        const proposed = notes(ctx.read, now, { kinds: [research.CANDIDATE_KIND] }).find(
          (r) =>
            !truthy(r.details?.accepted_at) &&
            ((key && r.candidateKey === key) ||
              (instrument !== null && r.instrument === instrument)),
        );
        if (proposed !== undefined) return refuse("candidate_proposed");
        if (data.candidate !== null) details.candidate = research.candidateJson(data.candidate);
      } else if (instrument === null && theme === null && data.segment === null) {
        return refuse("no_scope");
      }
      if (data.thesisRelation !== "none" && data.segment !== null) {
        const topic = topicThesis(ctx.read, data.segment);
        if (topic === undefined) return refuse("topic_without_thesis");
        if (topic.draft) return refuse("topic_thesis_draft");
      } else if (data.thesisRelation !== "none") {
        if (instrument === null) return refuse("relation_needs_thesis");
        if (theses(ctx.read, instrument).length === 0) return refuse("instrument_without_thesis");
      }
      const duplicate = duplicateOf(ctx, data, instrument, theme, candidateKey, now);
      if (duplicate !== undefined) {
        return refuse(duplicate.dismissedAt !== null ? "duplicate_dismissed" : "duplicate");
      }
      const observed = data.observedAt ?? now;
      const brief = hasBrief(data.details);
      if (data.segment !== null && !(brief && run !== undefined && isFullRefresh(run))) {
        if (segmentWeekNote(ctx, data.segment, observed, now, brief) !== undefined) {
          return refuse(brief ? "segment_week_brief" : "segment_week");
        }
      }
      if (nearDuplicateOf(ctx, data, instrument, candidateKey, now) !== null) {
        return refuse("near_duplicate");
      }
      if (
        input.createdBy === AGENT &&
        (run === undefined || (isWeekly(run) && !isFullRefresh(run)))
      ) {
        const problem = noveltyProblem(ctx, data, instrument, now);
        if (problem !== null) return refuse(problem);
      }
      const warnings: string[] = [];
      if (instrument !== null && !owned.has(instrument)) warnings.push("not_held_or_watched");

      const note = ctx.newGid();
      const expires = research.noteExpiresAt(data, now);
      const sources = research.noteSourcesJson(data);
      const stored = Object.keys(details).length > 0 ? details : null;
      ctx.emit("note.added", note, {
        run: run?.gid ?? null,
        instrument,
        theme,
        segment: data.segment,
        kind: data.kind,
        polarity: data.polarity,
        strength: data.strength,
        thesisRelation: data.thesisRelation,
        thesisField: data.thesisField,
        title: data.title,
        summary: data.summary,
        sources,
        details: stored,
        candidateKey,
        signal: null,
        observedAt: instantEvent(observed),
        expiresAt: instantEvent(expires),
        createdBy: input.createdBy,
        stamps: { created_at: instantEvent(now), updated_at: instantEvent(now) },
      });
      const row: ResearchNote = {
        gid: note,
        id: Number.MAX_SAFE_INTEGER,
        run: run?.gid ?? null,
        instrument,
        theme,
        segment: data.segment,
        kind: data.kind,
        polarity: data.polarity,
        strength: data.strength,
        thesisRelation: data.thesisRelation,
        thesisField: data.thesisField,
        title: data.title,
        summary: data.summary,
        sources,
        details: stored,
        candidateKey,
        signal: null,
        observedAt: observed,
        expiresAt: expires,
        createdBy: input.createdBy,
        dismissedAt: null,
        cooldownUntil: null,
        createdAt: now,
        updatedAt: now,
        readAt: input.createdBy === AGENT ? null : now,
      };
      const record = signalRecord(row, 0);
      const key = research.noteKey(record);
      let signal: SyncResult | null = null;
      if (key !== null && research.severityOf(record, now) !== null) {
        signal = syncResearchSignal(ctx, key, {
          now,
          lang: input.lang,
          notify: notifyPolicy(ctx.read),
          overlay: new Map([[note, row]]),
        });
      }
      afterAdded?.(ctx, row);
      return ok<AddedNote>({ note, signal, warnings });
    },
  });
}

export const addResearchNote = researchNoteCommand();

// ------------------------------------------------------------------ read marks

export const markResearchRead = defineCommand({
  id: "investments.research.markRead",
  input: z.object({
    instrument: gid.nullable().default(null),
    theme: z.string().nullable().default(null),
    ids: z.array(gid).nullable().default(null),
    segment: z.string().nullable().default(null),
  }),
  /**
   * Python `mark_read`: `read_at` on the vault's unread notes of one instrument, one segment, one
   * (old) theme or the given note gids (unknown ones ignored); exactly one selector. Returns how many
   * changed (idempotent: a note already read is not marked again).
   */
  run(ctx, input) {
    const now = nowOf(ctx);
    const given = [input.instrument, input.theme, input.ids, input.segment].filter(
      (x) => x !== null,
    );
    if (given.length !== 1) return refuse("bad_selector");
    let rows = notes(ctx.read, now, {}).filter((n) => isUnread(n, now));
    if (input.instrument !== null) {
      const own = ctx.read<{ n: number }>(
        `SELECT COUNT(*) AS n FROM research_notes
         WHERE instrument_id = (SELECT id FROM view_ids WHERE gid = ?)`,
        input.instrument,
      )[0]?.n;
      if (!own && !vaultInstrumentGids(ctx.read).has(input.instrument)) {
        return refuse("no_instrument");
      }
      const wanted = loadInstrument(ctx.read, input.instrument)?.id ?? input.instrument;
      rows = rows.filter((n) => n.instrument === wanted || n.instrument === input.instrument);
    } else if (input.segment !== null) {
      if (!research.isNoteSegment(input.segment)) return refuse("unknown_segment");
      rows = rows.filter((n) => n.segment === input.segment);
    } else if (input.theme !== null) {
      const text = research.cleanTheme(input.theme);
      if (text === null) return refuse("empty_theme");
      const key = research.themeKey(text);
      rows = rows.filter((n) => n.theme !== null && research.themeKey(n.theme) === key);
    } else {
      const ids = input.ids ?? [];
      if (ids.length === 0 || ids.length > MAX_READ_IDS) return refuse("bad_ids");
      const wanted = new Set(ids);
      rows = rows.filter((n) => wanted.has(n.gid));
    }
    for (const n of rows) {
      ctx.emit("note.read", n.gid, { stamps: { read_at: instantEvent(now) } });
    }
    return ok({ marked: rows.length });
  },
});

// ------------------------------------------------------------------ dismiss / restore

export function dismissResearchNoteCommand(
  afterDismissed?: (ctx: CommandContext, row: ResearchNote) => void,
) {
  return defineCommand({
    id: "investments.research.dismissNote",
    input: z.object({ note: gid, lang: z.enum(LANGS).default("pl") }),
    /**
     * Python `dismiss` (idempotent): the note's signal resolves when no other note keeps it open
     * (`note_dismissed`); a dismissed candidate is not proposed again for 90 days.
     */
    run(ctx, input) {
      const now = nowOf(ctx);
      const row = noteByGid(ctx.read, input.note);
      if (row === undefined) return refuse("no_note");
      if (row.dismissedAt !== null) return ok({ note: row.gid, signal: NO_SYNC });
      const cooldown = row.kind === research.CANDIDATE_KIND ? now + CANDIDATE_COOLDOWN : null;
      ctx.emit("note.dismissed", row.gid, {
        cooldownUntil: cooldown === null ? null : instantEvent(cooldown),
        stamps: { dismissed_at: instantEvent(now), updated_at: instantEvent(now) },
      });
      const next: ResearchNote = {
        ...row,
        dismissedAt: now,
        cooldownUntil: cooldown,
        updatedAt: now,
      };
      afterDismissed?.(ctx, next);
      const key = research.noteKey(signalRecord(next, 0));
      let signal = NO_SYNC;
      if (key !== null && row.signal !== null) {
        signal = syncResearchSignal(ctx, key, {
          now,
          lang: input.lang,
          notify: notifyPolicy(ctx.read),
          reason: research.CLOSED_DISMISSED,
          overlay: new Map([[row.gid, next]]),
        });
      }
      return ok({ note: row.gid, signal });
    },
  });
}
export const dismissResearchNote = dismissResearchNoteCommand();

export function restoreResearchNoteCommand(
  afterRestored?: (ctx: CommandContext, row: ResearchNote) => void,
) {
  return defineCommand({
    id: "investments.research.restoreNote",
    input: z.object({ note: gid, lang: z.enum(LANGS).default("pl") }),
    /**
     * Python `restore`: undo a dismissal within 15 minutes (a note that is not dismissed is a no-op);
     * the signal the dismissal resolved reopens (same episode), then follows the notes.
     */
    run(ctx, input) {
      const now = nowOf(ctx);
      const row = noteByGid(ctx.read, input.note);
      if (row === undefined) return refuse("no_note");
      if (row.dismissedAt === null) return ok({ note: row.gid, signal: NO_SYNC });
      if (now - row.dismissedAt > RESTORE_WINDOW) return refuse("undo_expired");
      ctx.emit("note.restored", row.gid, { stamps: { updated_at: instantEvent(now) } });
      const next: ResearchNote = { ...row, dismissedAt: null, cooldownUntil: null, updatedAt: now };
      afterRestored?.(ctx, next);
      const reopened = reopenDismissed(ctx, next, now, RESTORE_WINDOW);
      const record = signalRecord(next, 0);
      const key = research.noteKey(record);
      let signal = NO_SYNC;
      if (key !== null && research.severityOf(record, now) !== null) {
        signal = syncResearchSignal(ctx, key, {
          now,
          lang: input.lang,
          notify: notifyPolicy(ctx.read),
          overlay: new Map([[row.gid, next]]),
          ...(reopened === undefined ? {} : { open: reopened }),
        });
      }
      return ok({ note: row.gid, signal });
    },
  });
}
export const restoreResearchNote = restoreResearchNoteCommand();

// ------------------------------------------------------------------ housekeeping

export interface HousekeepingStats {
  readonly research_signals_resolved: number;
  readonly research_runs_interrupted: number;
}

/**
 * Python `housekeeping`: resolve research signals none of whose notes qualify any more (expired) and
 * close runs left running for 4 hours as failed. `skip` = runs this batch already closed.
 */
function housekeep(
  ctx: CommandContext,
  now: Instant,
  lang: UiLang,
  skip: ReadonlySet<string> = new Set(),
): HousekeepingStats {
  let resolved = 0;
  let policy: ReadonlySet<string> | undefined;
  for (const s of openResearchSignals(ctx.read)) {
    const rows = weekNoteRows(ctx.read, s.dedupKey);
    const records = rows.map((n, i) => signalRecord(n, i + 1));
    const mine = records.filter((r) => research.noteKey(r) === s.dedupKey);
    if (research.candidateFor(s.dedupKey, mine, now, lang) === null) {
      policy ??= notifyPolicy(ctx.read);
      syncResearchSignal(ctx, s.dedupKey, { now, lang, notify: policy });
      resolved += 1;
    }
  }
  let interrupted = 0;
  for (const run of staleRuns(ctx.read, now)) {
    if (skip.has(run.gid) || !isStale(ctx.read, run, now)) continue;
    ctx.emit("researchRun.finished", run.gid, {
      status: "failed",
      counts: { ...runCounts(ctx.read, run), ...run.counts, reason: "interrupted" },
      stamps: { finished_at: instantEvent(lastActivity(ctx.read, run)) },
    });
    interrupted += 1;
  }
  return { research_signals_resolved: resolved, research_runs_interrupted: interrupted };
}

export const researchHousekeeping = defineCommand({
  id: "investments.research.housekeeping",
  input: z.object({ lang: z.enum(LANGS).default("pl") }),
  /** Python `housekeeping`, for the daily check: leader only (`notes_expired` is a LEADER close). */
  run(ctx, input) {
    if (!ctx.lease.isHolder()) return refuse("not_leader");
    return ok(housekeep(ctx, nowOf(ctx), input.lang));
  },
});
