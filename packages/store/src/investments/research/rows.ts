// Research rows of one vault's view (Python `InvResearchRun`, `InvResearchNote`, `InvTopicThesis`)
// decoded to domain values: gids for every reference, aware UTC instants (`research.Instant`, bigint
// microseconds) for every timestamp, parsed JSON. Shared by the research queries, commands and views.
//
// Note -> signal: `research_notes.signal_id` holds the signal gid as named (S25-F5); the decoded
// `signal` is its episode (`inv_signal_aliases`), else the named gid while the open is not held.
import type { IsoDate } from "@cashu/domain";
import { research } from "@cashu/domain/investments";
import { gidOf, jsonList, jsonObject, type Read } from "../queries/shared.js";
import { compareReadRank, creationRanks } from "../views/stableOrder.js";

type Instant = research.Instant;

// ------------------------------------------------------------------ time

const VIEW_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;
const EVENT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

function instantOf(m: RegExpExecArray): Instant {
  return research.utcInstant(
    m[1] as IsoDate,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number((m[5] ?? "").padEnd(6, "0")),
  );
}

/** A stored view timestamp (`YYYY-MM-DD HH:MM:SS.ffffff`, UTC) as an instant. */
export function viewInstant(view: string): Instant {
  const m = VIEW_RE.exec(view);
  if (m === null) throw new RangeError("not a view timestamp");
  return instantOf(m);
}

/** A nullable stored view timestamp as an instant. */
export const viewInstantOrNull = (view: string | null): Instant | null =>
  view === null ? null : viewInstant(view);

/** An event timestamp (`YYYY-MM-DDTHH:MM:SS[.f]Z`) as an instant. */
export function eventInstant(ts: string): Instant {
  const m = EVENT_RE.exec(ts);
  if (m === null) throw new RangeError("not an event timestamp");
  return instantOf(m);
}

function parts(at: Instant): { date: IsoDate; clock: string; micro: string } {
  const date = research.instantDate(at);
  const inDay = at % research.MICROS_PER_DAY;
  const seconds = Number(inDay / research.MICROS_PER_SECOND);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date,
    clock: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`,
    micro: String(inDay % research.MICROS_PER_SECOND).padStart(6, "0"),
  };
}

/** An instant as an event timestamp that folds back to the same microseconds. */
export function instantEvent(at: Instant): string {
  const p = parts(at);
  return `${p.date}T${p.clock}.${p.micro}Z`;
}

/** An instant as a stored view timestamp (SQL comparisons against view columns). */
export function instantView(at: Instant): string {
  const p = parts(at);
  return `${p.date} ${p.clock}.${p.micro}`;
}

/** The later of two instants (bigint: no `Math.max`). */
export function later(a: Instant, b: Instant): Instant {
  if (a > b) return a;
  return b;
}

/** The earlier of two instants. */
export function earlier(a: Instant, b: Instant): Instant {
  if (a < b) return a;
  return b;
}

/** Midnight UTC of `day`. */
export const dayStart = (day: IsoDate): Instant => research.utcInstant(day);

/** Python `utc_iso` of an aware UTC datetime (`...+00:00`, fraction only when non-zero). */
export const iso = (at: Instant | null): string | null =>
  at === null ? null : research.formatInstant(at);

/** Whole seconds between two instants (Python `int(timedelta.total_seconds())`, toward zero). */
export const secondsBetween = (from: Instant, to: Instant): number =>
  Number((to - from) / research.MICROS_PER_SECOND);

// ------------------------------------------------------------------ runs

export interface ResearchRun {
  readonly gid: string;
  /** View row id (fold order on this device): only a tie-breaker, never shipped. */
  readonly id: number;
  readonly startedAt: Instant;
  readonly finishedAt: Instant | null;
  readonly status: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly counts: Readonly<Record<string, unknown>>;
  readonly createdBy: string;
}

interface RunRow {
  gid: string;
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  scope: string | null;
  counts: string | null;
  created_by: string;
}

export const RUN_SQL = `SELECT r.gid, r.id, r.started_at, r.finished_at, r.status, r.scope, r.counts,
  r.created_by FROM research_runs r`;

export function toRun(r: RunRow): ResearchRun {
  return {
    gid: r.gid,
    id: r.id,
    startedAt: viewInstant(r.started_at),
    finishedAt: viewInstantOrNull(r.finished_at),
    status: r.status,
    scope: jsonObject(r.scope),
    counts: jsonObject(r.counts),
    createdBy: r.created_by,
  };
}

export type { RunRow };

// ------------------------------------------------------------------ notes

/** One stored research note (Python `InvResearchNote`) with gids and instants. */
export interface ResearchNote {
  readonly gid: string;
  /** View row id (fold order on this device): only a tie-breaker, never shipped. */
  readonly id: number;
  readonly run: string | null;
  /** The instrument's identity root. */
  readonly instrument: string | null;
  readonly theme: string | null;
  readonly segment: string | null;
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly thesisRelation: string;
  readonly thesisField: string | null;
  readonly title: string;
  readonly summary: string;
  readonly sources: readonly unknown[];
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly candidateKey: string | null;
  /** The signal episode the note created or joined. */
  readonly signal: string | null;
  readonly observedAt: Instant;
  readonly expiresAt: Instant;
  readonly createdBy: string;
  readonly dismissedAt: Instant | null;
  readonly cooldownUntil: Instant | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly readAt: Instant | null;
}

interface NoteRow {
  gid: string;
  id: number;
  run: string | null;
  instrument: string | null;
  theme: string | null;
  segment: string | null;
  kind: string;
  polarity: string;
  strength: number;
  thesis_relation: string;
  thesis_field: string | null;
  title: string;
  summary: string;
  sources: string | null;
  details: string | null;
  candidate_key: string | null;
  signal: string | null;
  observed_at: string;
  expires_at: string;
  created_by: string;
  dismissed_at: string | null;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
  read_at: string | null;
}

export const NOTE_SQL = `SELECT n.gid, n.id, ${gidOf("n.run_id")} AS run,
  ${gidOf("n.instrument_id")} AS instrument, n.theme, n.segment, n.kind, n.polarity, n.strength,
  n.thesis_relation, n.thesis_field, n.title, n.summary, n.sources, n.details, n.candidate_key,
  COALESCE(${gidOf("(SELECT signal_id FROM inv_signal_aliases WHERE id = n.signal_id)")},
           ${gidOf("n.signal_id")}) AS signal,
  n.observed_at, n.expires_at, n.created_by, n.dismissed_at, n.cooldown_until, n.created_at,
  n.updated_at, n.read_at FROM research_notes n`;

function detailsOf(text: string | null): Readonly<Record<string, unknown>> | null {
  if (text === null) return null;
  const v: unknown = JSON.parse(text);
  return v === null ? null : jsonObject(text);
}

export function toNote(r: NoteRow): ResearchNote {
  return {
    gid: r.gid,
    id: r.id,
    run: r.run,
    instrument: r.instrument,
    theme: r.theme,
    segment: r.segment,
    kind: r.kind,
    polarity: r.polarity,
    strength: r.strength,
    thesisRelation: r.thesis_relation,
    thesisField: r.thesis_field,
    title: r.title,
    summary: r.summary,
    sources: jsonList(r.sources),
    details: detailsOf(r.details),
    candidateKey: r.candidate_key,
    signal: r.signal,
    observedAt: viewInstant(r.observed_at),
    expiresAt: viewInstant(r.expires_at),
    createdBy: r.created_by,
    dismissedAt: viewInstantOrNull(r.dismissed_at),
    cooldownUntil: viewInstantOrNull(r.cooldown_until),
    createdAt: viewInstant(r.created_at),
    updatedAt: viewInstant(r.updated_at),
    readAt: viewInstantOrNull(r.read_at),
  };
}

export type { NoteRow };

/** Python truthiness of a decoded JSON value. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== "";
}

/** The note carries a `details.brief` object (P9). */
export function hasBrief(details: Readonly<Record<string, unknown>> | null): boolean {
  const brief = details?.brief;
  return typeof brief === "object" && brief !== null && !Array.isArray(brief);
}

/**
 * Dense comparison ranks from actual applied creation anchors, never timestamps or local ids.
 * A new prospective note has no applied anchor yet: its explicit command overlay orders it after
 * persisted notes, matching the serialized append. Replacements retain their original anchor.
 */
export function noteRanks(
  read: Read,
  notes: Iterable<{ readonly gid: string }>,
  pending?: ReadonlyMap<string, ResearchNote>,
): Map<string, number> {
  const gids = new Set([...notes].map((row) => row.gid));
  const ranks = creationRanks(read, "researchNotes", [...gids]);
  for (const gid of gids)
    if (!ranks.has(gid) && !pending?.has(gid))
      throw new Error("note is missing its applied creation anchor or prospective overlay");
  const stored = [...ranks.values()].sort(compareReadRank).map((row) => row.gid);
  const prospective = [...(pending?.keys() ?? [])].filter(
    (gid) => gids.has(gid) && !ranks.has(gid),
  );
  return new Map([...stored, ...prospective].map((gid, i) => [gid, i + 1]));
}

/** What the domain scoring reads from a note (`views.scored`), with `id` = its storing rank. */
export function scoredNote(n: ResearchNote, rank: number): research.ScoredNote {
  return {
    id: rank,
    kind: n.kind,
    polarity: n.polarity,
    strength: n.strength,
    thesisRelation: n.thesisRelation,
    observedAt: n.observedAt,
    createdAt: n.createdAt,
    expiresAt: n.expiresAt,
    dismissedAt: n.dismissedAt,
    thesisField: n.thesisField,
  };
}

/** What the research signal logic reads from a note, with `id` = its storing rank. */
export function signalRecord(n: ResearchNote, rank: number): research.ResearchNoteRecord {
  return {
    id: rank,
    kind: n.kind,
    polarity: n.polarity,
    strength: n.strength,
    thesisRelation: n.thesisRelation,
    thesisField: n.thesisField,
    title: n.title,
    sources: n.sources,
    details: n.details,
    instrumentId: n.instrument,
    segment: n.segment,
    theme: n.theme,
    createdAt: n.createdAt,
    expiresAt: n.expiresAt,
    dismissedAt: n.dismissedAt,
  };
}

// ------------------------------------------------------------------ topic theses

/** One topic thesis row (Python `InvTopicThesis`), rejections included. */
export interface TopicThesis {
  readonly gid: string;
  readonly segment: string;
  readonly thesis: string;
  readonly invalidation: string | null;
  readonly draft: boolean;
  readonly createdBy: string;
  readonly coreChangedAt: Instant;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly rejectedAt: Instant | null;
  readonly assessment: string | null;
  readonly outlook: string | null;
  readonly viewUpdatedAt: Instant | null;
  readonly viewSources: readonly Readonly<Record<string, unknown>>[] | null;
}

interface TopicRow {
  gid: string;
  segment: string;
  thesis: string;
  invalidation: string | null;
  draft: number;
  created_by: string;
  core_changed_at: string;
  created_at: string;
  updated_at: string;
  rejected_at: string | null;
  assessment: string | null;
  outlook: string | null;
  view_updated_at: string | null;
  view_sources: string | null;
}

export const TOPIC_SQL = `SELECT t.gid, t.segment, t.thesis, t.invalidation, t.draft, t.created_by,
  t.core_changed_at, t.created_at, t.updated_at, t.rejected_at, t.assessment, t.outlook,
  t.view_updated_at, t.view_sources FROM inv_topic_theses t`;

export function toTopic(r: TopicRow): TopicThesis {
  const sources = r.view_sources === null ? null : jsonList(r.view_sources);
  return {
    gid: r.gid,
    segment: r.segment,
    thesis: r.thesis,
    invalidation: r.invalidation,
    draft: r.draft !== 0,
    createdBy: r.created_by,
    coreChangedAt: viewInstant(r.core_changed_at),
    createdAt: viewInstant(r.created_at),
    updatedAt: viewInstant(r.updated_at),
    rejectedAt: viewInstantOrNull(r.rejected_at),
    assessment: r.assessment,
    outlook: r.outlook,
    viewUpdatedAt: viewInstantOrNull(r.view_updated_at),
    viewSources:
      sources === null ? null : (sources as readonly Readonly<Record<string, unknown>>[]),
  };
}

export type { TopicRow };
