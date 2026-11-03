// JSON views of the research layer (Python `research/views.py`): run and note dicts, the summary
// (thesis health per position, relation counts, 8-week sentiment and direction, last researched) and
// the review digest's `research` block. Shapes follow the Python contract (F6-RS) with every id a gid
// (gid.md 6) and every timestamp Python's `utc_iso`. Clock-free: `now` is a parameter.
import { pyCasefold } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { type Instrument, research } from "@cashu/domain/investments";
import { watchedInstrumentGids } from "../queries/alerts.js";
import { loadInstruments } from "../queries/instruments.js";
import { type ThesisView, theses } from "../queries/journal.js";
import type { Read } from "../queries/shared.js";
import { type SignalView, signalByGid } from "../queries/signals.js";
import {
  coveredRecently,
  heldInstrumentGids,
  isStale,
  isUnread,
  labelOf,
  latestRun,
  noteRows,
  openResearchSignals,
  RESTORE_WINDOW,
  researchable,
  runCounts,
  runningRun,
  runs,
} from "./queries.js";
import {
  earlier,
  instantView,
  iso,
  later,
  noteRanks,
  type ResearchNote,
  type ResearchRun,
  scoredNote,
  secondsBetween,
  truthy,
  viewInstant,
} from "./rows.js";

type Instant = research.Instant;

/** Python `HISTORY_DAYS`: 8 weeks of sentiment + the health window + a week. */
export const HISTORY_DAYS = 7 * research.SENTIMENT_WEEKS + research.HEALTH_WINDOW_DAYS + 7;
const DAY = research.MICROS_PER_DAY;

/** Python `instrument_brief`. */
export function instrumentBrief(inst: Instrument | undefined) {
  if (inst === undefined) return null;
  const [segment, source] = research.segmentOf(inst, inst.segment, inst.segmentBy);
  return {
    id: String(inst.id),
    label: labelOf(inst),
    symbol: inst.symbol,
    name: inst.name,
    isin: inst.isin,
    currency: String(inst.currency),
    asset_class: String(inst.assetClass),
    segment,
    segment_source: source,
  };
}

// ------------------------------------------------------------------ runs

/** Python `run_dict`: a stale running run shows as failed / interrupted at once. */
export function runView(read: Read, run: ResearchRun | undefined, now: Instant) {
  if (run === undefined) return null;
  const stale = isStale(read, run, now);
  const counts = { ...run.counts };
  const live = runCounts(read, run);
  const scope = run.scope;
  const list = (v: unknown) => (Array.isArray(v) ? [...v] : []);
  const flag = (v: unknown, fallback: boolean) => (v === undefined ? fallback : truthy(v));
  return {
    id: run.gid,
    status: stale ? "failed" : run.status,
    interrupted: stale || counts.reason === "interrupted",
    reason: truthy(counts.reason) ? counts.reason : stale ? "interrupted" : null,
    started_at: iso(run.startedAt),
    finished_at: iso(run.finishedAt),
    duration_s: run.finishedAt === null ? null : secondsBetween(run.startedAt, run.finishedAt),
    scheduled: truthy(scope.scheduled),
    full_refresh: truthy(scope.full_refresh),
    scope: {
      held: flag(scope.held, true),
      watchlist: flag(scope.watchlist, true),
      candidates: flag(scope.candidates, true),
      themes: list(scope.themes),
      segments: list(scope.segments),
      instrument_ids: list(scope.instrument_ids),
      covered_instrument_ids: list(scope.covered_instrument_ids),
      full_refresh: truthy(scope.full_refresh),
    },
    counts: { ...counts, ...live },
    notes: live.notes,
    signals: live.signals,
    created_by: run.createdBy,
  };
}

export type RunViewShape = NonNullable<ReturnType<typeof runView>>;

/** Python `runs_view`. */
export function runsView(read: Read, now: Instant, limit = 20) {
  return runs(read, limit).map((r) => runView(read, r, now) as RunViewShape);
}

// ------------------------------------------------------------------ notes

/** Python `core_changed_at`: the thesis' last core change (`updated_at` for old rows). */
export const coreChangedAt = (t: ThesisView): Instant =>
  viewInstant(t.coreChangedAt ?? t.updatedAt);

/** Python `_theses_by_instrument`: the newest thesis per instrument. */
export function thesesByInstrument(read: Read): Map<string, ThesisView> {
  const out = new Map<string, ThesisView>();
  for (const t of theses(read)) if (!out.has(t.instrument)) out.set(t.instrument, t);
  return out;
}

export interface NoteContext {
  readonly insts: ReadonlyMap<string, Instrument>;
  readonly signals: ReadonlyMap<string, SignalView>;
  readonly held: ReadonlySet<string>;
  readonly watched: ReadonlySet<string>;
  readonly theses: ReadonlyMap<string, ThesisView>;
  readonly lang: UiLang;
}

const pick = (s: unknown, key: string): unknown =>
  typeof s === "object" && s !== null ? ((s as Record<string, unknown>)[key] ?? null) : null;

/**
 * Python `note_dict`: `predates_thesis` = stored before the last core change of its instrument's
 * newest thesis (it still counts in health, P2).
 */
export function noteView(n: ResearchNote, ctx: NoteContext, now: Instant) {
  const details: Record<string, unknown> = { ...(n.details ?? {}) };
  const candidate = details.candidate ?? null;
  delete details.candidate;
  const accepted = {
    accepted_at: details.accepted_at ?? null,
    watchlist_item_id: details.watchlist_item_id ?? null,
    thesis_id: details.thesis_id ?? null,
  };
  for (const k of [
    "accepted_at",
    "watchlist_item_id",
    "thesis_id",
    "created_watchlist_item",
    "created_thesis",
    "previous_instrument_id",
    // Legacy topic views were briefly stored on notes; they now live under the topic thesis.
    "assessment",
    "outlook",
  ]) {
    delete details[k];
  }
  const signal = n.signal === null ? undefined : ctx.signals.get(n.signal);
  const inst = n.instrument === null ? undefined : ctx.insts.get(n.instrument);
  const thesis = n.instrument === null ? undefined : ctx.theses.get(n.instrument);
  const c = (key: string) => pick(candidate, key);
  return {
    id: n.gid,
    run_id: n.run,
    kind: n.kind,
    polarity: n.polarity,
    strength: n.strength,
    thesis_relation: n.thesisRelation,
    thesis_field: n.thesisField,
    title: n.title,
    summary: n.summary,
    sources: n.sources.map((s) => ({
      title: pick(s, "title"),
      url: pick(s, "url"),
      publisher: pick(s, "publisher"),
      published_at: pick(s, "published_at"),
    })),
    instrument_id: n.instrument,
    instrument: instrumentBrief(inst),
    theme: n.theme,
    segment: n.segment,
    segment_label: n.segment ? research.segmentLabel(n.segment, ctx.lang) : null,
    candidate:
      n.kind !== research.CANDIDATE_KIND
        ? null
        : {
            symbol: c("symbol") || (inst ? inst.symbol : null),
            name: c("name") || (inst ? inst.name : null),
            exchange: c("exchange"),
            currency: c("currency"),
            key: n.candidateKey,
            ...accepted,
          },
    details: Object.keys(details).length > 0 ? details : null,
    signal_id: n.signal,
    signal:
      signal === undefined
        ? null
        : { id: signal.gid, status: signal.status, severity: signal.severity },
    held: n.instrument !== null && ctx.held.has(n.instrument),
    watched: n.instrument !== null && ctx.watched.has(n.instrument),
    observed_at: iso(n.observedAt),
    expires_at: iso(n.expiresAt),
    expired: n.expiresAt <= now,
    created_by: n.createdBy,
    created_at: iso(n.createdAt),
    dismissed: n.dismissedAt !== null,
    dismissed_at: iso(n.dismissedAt),
    restorable_until: n.dismissedAt === null ? null : iso(n.dismissedAt + RESTORE_WINDOW),
    cooldown_until: iso(n.cooldownUntil),
    read_at: iso(n.readAt),
    unread: isUnread(n, now),
    predates_thesis:
      thesis !== undefined &&
      n.kind !== research.CANDIDATE_KIND &&
      n.createdAt < coreChangedAt(thesis),
  };
}

export type NoteViewShape = ReturnType<typeof noteView>;

/** Python `_context`: what the note dicts of `rows` need. */
export function noteContext(
  read: Read,
  rows: readonly ResearchNote[],
  now: Instant,
  lang: UiLang,
): NoteContext {
  const ids = new Set(rows.flatMap((r) => (r.instrument === null ? [] : [r.instrument])));
  const signals = new Map<string, SignalView>();
  for (const r of rows) {
    if (r.signal === null || signals.has(r.signal)) continue;
    const s = signalByGid(read, r.signal);
    if (s !== undefined) signals.set(r.signal, s);
  }
  return {
    insts: loadInstruments(read, ids),
    signals,
    held: heldInstrumentGids(read, research.instantDate(now)),
    watched: watchedInstrumentGids(read),
    theses: ids.size > 0 ? thesesByInstrument(read) : new Map(),
    lang,
  };
}

/** Python `notes_view`. */
export function notesView(read: Read, rows: readonly ResearchNote[], now: Instant, lang: UiLang) {
  const ctx = noteContext(read, rows, now, lang);
  return rows.map((r) => noteView(r, ctx, now));
}

// ------------------------------------------------------------------ summary

function recentNotes(read: Read, since: Instant): ResearchNote[] {
  return noteRows(read, "n.observed_at >= ?", [instantView(since)]);
}

/** Python `_health`: thesis health at `at` (a thesis created after `at` did not exist then). */
function health(
  notes: readonly research.ScoredNote[],
  thesis: ThesisView | undefined,
  at: Instant,
  coveredAt: Instant | null,
): research.HealthResult {
  let t = thesis;
  if (t !== undefined && viewInstant(t.createdAt) > at) t = undefined;
  let changed: Instant | null = null;
  if (t !== undefined) {
    const core = coreChangedAt(t);
    changed = core <= at ? core : viewInstant(t.createdAt);
  }
  return research.thesisHealth(notes, at, {
    hasThesis: t !== undefined,
    thesisChangedAt: changed,
    researched: coveredAt !== null,
  });
}

/** Python `health_by_instrument`: thesis health at `now` per instrument (plan checks, P1). */
export function healthByInstrument(
  read: Read,
  ids: Iterable<string>,
  now: Instant,
  pendingNotes?: ReadonlyMap<string, ResearchNote>,
): Map<
  string,
  { health: research.HealthResult; thesis: ThesisView | undefined; noteIds: string[] }
> {
  const wanted = new Set(ids);
  const out = new Map<
    string,
    { health: research.HealthResult; thesis: ThesisView | undefined; noteIds: string[] }
  >();
  if (wanted.size === 0) return out;
  const since = now - BigInt(HISTORY_DAYS) * DAY;
  const stored = recentNotes(read, since);
  const rows =
    pendingNotes === undefined
      ? stored
      : [
          ...new Map([
            ...stored.map((row) => [row.gid, row] as const),
            ...[...pendingNotes].filter(([, row]) => row.observedAt >= since),
          ]).values(),
        ];
  const ranks = noteRanks(read, rows, pendingNotes);
  const byRank = new Map([...ranks].map(([g, r]) => [r, g]));
  const byInstrument = new Map<string, ResearchNote[]>();
  for (const r of rows) {
    if (r.instrument !== null && wanted.has(r.instrument) && r.kind !== research.CANDIDATE_KIND) {
      byInstrument.set(r.instrument, [...(byInstrument.get(r.instrument) ?? []), r]);
    }
  }
  const thesesOf = thesesByInstrument(read);
  const covered = coveredRecently(read, now);
  for (const g of wanted) {
    const notes = (byInstrument.get(g) ?? []).map((r) => scoredNote(r, ranks.get(r.gid) as number));
    const window = research.windowNotes(notes, now);
    const h = health(
      notes,
      thesesOf.get(g),
      now,
      covered.get(g) ?? (window.length > 0 ? now : null),
    );
    out.set(g, {
      health: h,
      thesis: thesesOf.get(g),
      noteIds: h.noteIds.map((id) => byRank.get(id) as string),
    });
  }
  return out;
}

const RELATION_FIELDS = ["supports", "weakens", "invalidates", "fulfills", "neutral"] as const;

/** Python `_field_counts`. */
function fieldCounts(notes: readonly research.ScoredNote[]) {
  const fields = new Map<string, Record<string, number>>();
  for (const n of notes) {
    if (n.thesisField && (RELATION_FIELDS as readonly string[]).includes(n.thesisRelation)) {
      const entry =
        fields.get(n.thesisField) ?? Object.fromEntries(RELATION_FIELDS.map((k) => [k, 0]));
      entry[n.thesisRelation] = (entry[n.thesisRelation] ?? 0) + 1;
      fields.set(n.thesisField, entry);
    }
  }
  return [...fields.keys()]
    .sort()
    .map((field) => ({ field, ...(fields.get(field) as Record<string, number>) }));
}

/** Python `_latest`: the newest active non-candidate note. */
function latestOf(rows: readonly ResearchNote[], now: Instant, ranks: ReadonlyMap<string, number>) {
  let best: ResearchNote | undefined;
  for (const r of rows) {
    if (r.dismissedAt !== null || r.expiresAt <= now || r.kind === research.CANDIDATE_KIND)
      continue;
    if (
      best === undefined ||
      r.observedAt > best.observedAt ||
      (r.observedAt === best.observedAt && (ranks.get(r.gid) ?? 0) > (ranks.get(best.gid) ?? 0))
    ) {
      best = r;
    }
  }
  return best;
}

const briefNote = (r: ResearchNote | undefined) =>
  r === undefined
    ? null
    : {
        id: r.gid,
        title: r.title,
        kind: r.kind,
        polarity: r.polarity,
        thesis_relation: r.thesisRelation,
        observed_at: iso(r.observedAt),
      };

/** Python `_candidate_counts`. */
function candidateCounts(read: Read, now: Instant) {
  let open = 0;
  let accepted = 0;
  let cooldown = 0;
  for (const r of noteRows(read, "n.kind = 'candidate'")) {
    if (truthy(r.details?.accepted_at)) accepted += 1;
    else if (r.dismissedAt !== null) {
      if (r.cooldownUntil !== null && r.cooldownUntil > now) cooldown += 1;
    } else if (r.expiresAt > now) open += 1;
  }
  return { open, accepted, dismissed_in_cooldown: cooldown };
}

export interface SummaryOptions {
  readonly now: Instant;
  readonly lang: UiLang;
  /**
   * The held positions' weights (`views.positions` rows: instrument gid -> weight, S22a); the
   * held set is its keys. Python loads them when omitted; here the caller passes them.
   */
  readonly weights: ReadonlyMap<string, number | null>;
}

/** Python `summary`: thesis health and sentiment per position (held, watched, or with notes). */
export function researchSummary(read: Read, o: SummaryOptions) {
  const now = o.now;
  const held = new Set(o.weights.keys());
  const watched = watchedInstrumentGids(read);
  const rows = recentNotes(read, now - BigInt(HISTORY_DAYS) * DAY);
  const ranks = noteRanks(read, rows);
  const byRank = new Map([...ranks].map(([g, r]) => [r, g]));
  const byInstrument = new Map<string, ResearchNote[]>();
  for (const r of rows) {
    if (r.instrument !== null && r.kind !== research.CANDIDATE_KIND) {
      byInstrument.set(r.instrument, [...(byInstrument.get(r.instrument) ?? []), r]);
    }
  }
  const thesesOf = thesesByInstrument(read);
  const covered = coveredRecently(read, now);
  const lastNoteAt = new Map<string, Instant>();
  for (const r of read<{ gid: string; at: string }>(
    `SELECT (SELECT gid FROM view_ids WHERE id = instrument_id) AS gid, MAX(created_at) AS at
     FROM research_notes WHERE instrument_id IS NOT NULL GROUP BY instrument_id`,
  )) {
    lastNoteAt.set(r.gid, viewInstant(r.at));
  }
  const unread = noteRows(read, "n.read_at IS NULL").filter((n) => isUnread(n, now));
  const unreadBy = new Map<string, number>();
  for (const r of unread) {
    if (r.instrument !== null) unreadBy.set(r.instrument, (unreadBy.get(r.instrument) ?? 0) + 1);
  }
  const ids = new Set([...held, ...watched, ...byInstrument.keys()]);
  const items = [...loadInstruments(read, ids)].flatMap(([g, inst]) => {
    if (!researchable(inst)) return [];
    const own = byInstrument.get(g) ?? [];
    const notes = own.map((r) => scoredNote(r, ranks.get(r.gid) as number));
    const thesis = thesesOf.get(g);
    const window = research.windowNotes(notes, now);
    const h = health(notes, thesis, now, covered.get(g) ?? (window.length > 0 ? now : null));
    const values = research.sentimentWeeks(notes, now);
    const latest = latestOf(own, now, ranks);
    const researched = [lastNoteAt.get(g), covered.get(g)].filter(
      (t): t is Instant => t !== undefined,
    );
    return [
      {
        instrument_id: g,
        instrument: instrumentBrief(inst),
        label: labelOf(inst),
        held: held.has(g),
        watched: watched.has(g),
        weight: o.weights.get(g) ?? null,
        has_thesis: thesis !== undefined,
        entry_type: thesis?.entryType ?? null,
        health: h.state,
        health_rank: research.healthRank(h.state),
        counts: h.counts,
        thesis_relation: h.relation,
        note_ids: h.noteIds.map((id) => byRank.get(id) as string),
        health_predates_thesis: h.predatesThesis,
        fields: fieldCounts(window),
        latest_polarity: latest?.polarity ?? null,
        latest_note: briefNote(latest),
        notes: window.length,
        sentiment_8w: values,
        direction: research.direction(values),
        last_researched_at: researched.length > 0 ? iso(researched.reduce(later)) : null,
        unread: unreadBy.get(g) ?? 0,
      },
    ];
  });
  const sortKey = (x: (typeof items)[number]) =>
    [x.health_rank, x.held ? 0 : 1, -(x.weight ?? 0), pyCasefold(x.label ?? "")] as const;
  items.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return (ka[i] as number | string) < (kb[i] as number | string) ? -1 : 1;
    }
    return 0;
  });
  const today = research.instantDate(now);
  const weeks = research.weekStarts(today);
  const candidates = rows.filter((r) => r.kind === research.CANDIDATE_KIND);
  return {
    as_of: today,
    window_days: research.HEALTH_WINDOW_DAYS,
    note_ttl_days: research.RESEARCH_NOTE_TTL_DAYS,
    weeks: weeks.map((d) => research.isoWeek(d)),
    week_starts: weeks,
    last_run: runView(read, latestRun(read), now),
    running: runningRun(read, now) !== undefined,
    instruments: items,
    candidates: candidateCounts(read, now),
    totals: {
      notes_active: rows.filter(
        (r) => r.dismissedAt === null && r.expiresAt > now && r.kind !== research.CANDIDATE_KIND,
      ).length,
      notes_this_week: rows.filter(
        (r) =>
          r.dismissedAt === null &&
          research.isoWeek(research.instantDate(r.createdAt)) === research.isoWeek(today),
      ).length,
      candidates_open: candidates.filter(
        (r) => r.dismissedAt === null && r.expiresAt > now && !truthy(r.details?.accepted_at),
      ).length,
      signals_open: openResearchSignals(read).length,
      // Only notes the app can mark read: a held or watched instrument's, a segment's or a theme's.
      notes_unread: unread.filter(
        (r) =>
          r.segment ||
          r.theme ||
          (r.instrument !== null && (held.has(r.instrument) || watched.has(r.instrument))),
      ).length,
    },
  };
}

// ------------------------------------------------------------------ review digest

/** The segment part of the digest (Python `_digest_segments`), computed by the caller. */
export interface DigestSegments {
  readonly segments: readonly unknown[];
  readonly market: Readonly<Record<string, unknown>> | null;
}

export interface DigestOptions {
  readonly now: Instant;
  /** Since the last review: an instant, or null for the last 7 days. */
  readonly since: Instant | null;
  /** The week's market segments (`digestSegments(segmentsView(...))`); `[]` / null when unavailable. */
  readonly segments?: DigestSegments;
  /** Macro regimes whose state changed in the period (Python `macro_service.changes`, S20 / S22a). */
  readonly macroChanges?: readonly unknown[];
}

const HIGHLIGHT_RANK: Readonly<Record<string, number>> = {
  invalidates: 0,
  weakens: 1,
  fulfills: 2,
};

/** Python `research_digest`: what research found since the last review. */
export function researchDigest(read: Read, o: DigestOptions) {
  const now = o.now;
  const start = o.since ?? now - 7n * DAY;
  const from = earlier(start, now) - BigInt(HISTORY_DAYS) * DAY;
  const rows = recentNotes(read, from);
  const ranks = noteRanks(read, rows);
  const byRank = new Map([...ranks].map(([g, r]) => [r, g]));
  const fresh = rows.filter((r) => r.createdAt >= start);
  const active = fresh.filter((r) => r.dismissedAt === null);
  const counts = research.emptyCounts();
  const byKind: Record<string, number> = {};
  for (const r of active) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.thesisRelation in counts) counts[r.thesisRelation as keyof research.RelationCounts] += 1;
    if (r.kind === "community") counts.community += 1;
  }
  const thesesOf = thesesByInstrument(read);
  const byInstrument = new Map<string, ResearchNote[]>();
  for (const r of rows) {
    if (r.instrument !== null && r.kind !== research.CANDIDATE_KIND) {
      byInstrument.set(r.instrument, [...(byInstrument.get(r.instrument) ?? []), r]);
    }
  }
  const ids = new Set([...thesesOf.keys(), ...byInstrument.keys()]);
  const loaded = loadInstruments(read, ids);
  const coveredNow = coveredRecently(read, now);
  const coveredThen = coveredRecently(read, start);
  const changed: {
    instrument_id: string;
    label: string | null;
    from: string;
    to: string;
    note_ids: string[];
    counts: research.RelationCounts;
  }[] = [];
  let unchanged = 0;
  for (const g of [...ids].sort()) {
    const inst = loaded.get(g);
    if (!researchable(inst)) continue;
    const notes = (byInstrument.get(g) ?? []).map((r) => scoredNote(r, ranks.get(r.gid) as number));
    const thesis = thesesOf.get(g);
    if (thesis === undefined) continue;
    const before = health(
      notes,
      thesis,
      start,
      coveredThen.get(g) ?? (research.windowNotes(notes, start).length > 0 ? start : null),
    );
    const after = health(
      notes,
      thesis,
      now,
      coveredNow.get(g) ?? (research.windowNotes(notes, now).length > 0 ? now : null),
    );
    if (before.state === after.state) {
      unchanged += 1;
      continue;
    }
    const noteIds = after.noteIds.length > 0 ? after.noteIds : before.noteIds;
    changed.push({
      instrument_id: g,
      label: labelOf(inst),
      from: before.state,
      to: after.state,
      note_ids: noteIds.map((id) => byRank.get(id) as string),
      counts: after.counts,
    });
  }
  changed.sort((a, b) => {
    const ra = research.healthRank(a.to);
    const rb = research.healthRank(b.to);
    if (ra !== rb) return ra - rb;
    const la = a.label ?? "";
    const lb = b.label ?? "";
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const rank = (r: ResearchNote) => ranks.get(r.gid) ?? 0;
  const candidates = active
    .filter((r) => r.kind === research.CANDIDATE_KIND && !truthy(r.details?.accepted_at))
    .sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt > b.createdAt ? -1 : 1) : rank(b) - rank(a),
    );
  const highlights = active
    .filter(
      (r) =>
        r.kind !== research.CANDIDATE_KIND &&
        (r.signal !== null ||
          r.strength >= 3 ||
          ["invalidates", "weakens", "fulfills"].includes(r.thesisRelation)),
    )
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ra = HIGHLIGHT_RANK[a.r.thesisRelation] ?? 3;
      const rb = HIGHLIGHT_RANK[b.r.thesisRelation] ?? 3;
      if (ra !== rb) return ra - rb;
      if (a.r.strength !== b.r.strength) return b.r.strength - a.r.strength;
      if (a.r.createdAt !== b.r.createdAt) return a.r.createdAt > b.r.createdAt ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ r }) => r);
  const runsInPeriod =
    read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM research_runs WHERE started_at >= ?",
      instantView(start),
    )[0]?.n ?? 0;
  const signalsNew =
    read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inv_signals WHERE dedup_key LIKE 'research:%' AND first_seen_at >= ?",
      instantView(start),
    )[0]?.n ?? 0;
  return {
    since: iso(start),
    run: runView(read, latestRun(read), now),
    ran_in_period: runsInPeriod > 0,
    runs_in_period: runsInPeriod,
    notes_count: active.length,
    signals_count: signalsNew,
    counts,
    by_kind: byKind,
    theses_changed: changed,
    theses_unchanged: unchanged,
    segments: [...(o.segments?.segments ?? [])],
    market: o.segments?.market ?? null,
    macro_changes: [...(o.macroChanges ?? [])],
    candidates: candidates.map((r) => r.gid),
    highlights: highlights.slice(0, 10).map((r) => r.gid),
    health_states: Object.values(research.Health),
  };
}
