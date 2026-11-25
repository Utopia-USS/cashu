/**
 * Pure research scoring (`research/scoring.py`): ISO weeks, the weekly sentiment score, the trend
 * direction and the thesis health of a position. No clock: every function takes the instant it
 * scores at, so the review digest can score "as of the last review" with the same code.
 *
 * Sentiment of one ISO week = `sum(polarity_sign * weight) / (3 * notes)` over the notes observed in
 * that week that were stored and not dismissed at the scoring instant (expired notes still count).
 * `weight` = the note's strength (1-3), capped at 1 for community notes. Candidate notes never count.
 * A week without notes is null ("no data", not "balanced").
 *
 * Direction = the sum of the last 4 weekly scores vs the previous 4 (empty weeks count 0).
 *
 * Thesis health of a position (30-day window of stored, non-dismissed, non-expired notes; notes
 * stored before the thesis' last core change still count and only set `predatesThesis`, P2):
 * invalidated > weakened > fulfilled > supported > current; `no_research` (thesis, nothing
 * researched in 30 days), `no_thesis` (no thesis record).
 */

import { addDays, type IsoDate, isoWeekLabel, weekStart as isoWeekStart } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { pySum } from "../performance/floats.js";
import { type Instant, instantDate, MICROS_PER_DAY } from "./instant.js";

export const SENTIMENT_WEEKS = 8;
export const DIRECTION_DELTA = 1.0;
export const HEALTH_WINDOW_DAYS = 30;
export const COMMUNITY_KIND = "community";
export const CANDIDATE_KIND = "candidate";

export const POLARITY_SIGN: ReadonlyMap<string, number> = new Map([
  ["positive", 1],
  ["negative", -1],
  ["neutral", 0],
]);
/** How much a relation says about the thesis (the strongest one wins in summaries). */
export const RELATION_RANK: ReadonlyMap<string, number> = new Map([
  ["invalidates", 5],
  ["weakens", 4],
  ["fulfills", 3],
  ["supports", 2],
  ["neutral", 1],
  ["none", 0],
]);
/** Relations that bear on the thesis (the others are neutral / unrelated). */
export const BEARING_RELATIONS: readonly string[] = Object.freeze([
  "supports",
  "weakens",
  "invalidates",
  "fulfills",
]);

export const Health = Object.freeze({
  INVALIDATED: "invalidated",
  WEAKENED: "weakened",
  FULFILLED: "fulfilled",
  SUPPORTED: "supported",
  CURRENT: "current",
  NO_RESEARCH: "no_research",
  NO_THESIS: "no_thesis",
} as const);
export type Health = (typeof Health)[keyof typeof Health];

/** Attention order of the health states (most attention first): the order of summary rows. */
export const HEALTH_ORDER: readonly Health[] = Object.freeze([
  Health.INVALIDATED,
  Health.WEAKENED,
  Health.FULFILLED,
  Health.NO_RESEARCH,
  Health.NO_THESIS,
  Health.SUPPORTED,
  Health.CURRENT,
]);

export const Direction = Object.freeze({
  RISING: "rising",
  FALLING: "falling",
  STABLE: "stable",
} as const);
export type Direction = (typeof Direction)[keyof typeof Direction];

/** What scoring needs from a stored note (aware UTC instants). */
export interface ScoredNote {
  readonly id: number;
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly thesisRelation: string;
  readonly observedAt: Instant;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly dismissedAt?: Instant | null;
  readonly thesisField?: string | null;
}

/** Stored and not dismissed at `at`. */
export function storedAt(note: ScoredNote, at: Instant): boolean {
  return (
    note.createdAt <= at &&
    (note.dismissedAt === undefined || note.dismissedAt === null || note.dismissedAt > at)
  );
}

/** Stored, not dismissed and not expired at `at`. */
export function activeAt(note: ScoredNote, at: Instant): boolean {
  return storedAt(note, at) && note.expiresAt > at;
}

// ------------------------------------------------------------------------------------ weeks

/** Monday of `day`'s ISO week. */
export function weekStart(day: IsoDate): IsoDate {
  return isoWeekStart(day);
}

/** `2026-W40` (ISO year and week number). */
export function isoWeek(day: IsoDate): string {
  return isoWeekLabel(day);
}

/** Mondays of the last `weeks` ISO weeks, oldest first; the last one is `today`'s week. */
export function weekStarts(today: IsoDate, weeks: number = SENTIMENT_WEEKS): IsoDate[] {
  const current = weekStart(today);
  return Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
}

// ------------------------------------------------------------------------------------ sentiment

/** The strength a note counts with: 1-3, community capped at 1. */
export function noteWeight(kind: string, strength: number): number {
  const value = Math.max(1, Math.min(3, Math.trunc(strength)));
  return kind === COMMUNITY_KIND ? 1 : value;
}

/** `sum(sign * weight) / (3 * n)` in [-1, 1]; null without notes. */
export function weekScore(notes: readonly ScoredNote[]): number | null {
  if (notes.length === 0) return null;
  let total = 0;
  for (const n of notes)
    total += (POLARITY_SIGN.get(n.polarity) ?? 0) * noteWeight(n.kind, n.strength);
  return roundFloat(total / (3 * notes.length), 4);
}

/**
 * One score per ISO week (oldest first, the last = `at`'s week) over the notes stored and not
 * dismissed at `at`; candidate notes never count.
 */
export function sentimentWeeks(
  notes: Iterable<ScoredNote>,
  at: Instant,
  weeks: number = SENTIMENT_WEEKS,
): (number | null)[] {
  const starts = weekStarts(instantDate(at), weeks);
  const index = new Map(starts.map((start, i) => [start, i]));
  const buckets: ScoredNote[][] = starts.map(() => []);
  for (const note of notes) {
    if (note.kind === CANDIDATE_KIND || !storedAt(note, at)) continue;
    const i = index.get(weekStart(instantDate(note.observedAt)));
    if (i !== undefined) buckets[i]?.push(note);
  }
  return buckets.map(weekScore);
}

/** Last 4 weeks vs the previous 4 (empty weeks count 0). */
export function direction(values: readonly (number | null)[]): Direction {
  const recent = pySum(values.slice(-4).map((v) => v || 0.0));
  const previous = pySum(values.slice(-8, -4).map((v) => v || 0.0));
  const delta = recent - previous;
  if (delta > DIRECTION_DELTA) return Direction.RISING;
  if (delta < -DIRECTION_DELTA) return Direction.FALLING;
  return Direction.STABLE;
}

// ------------------------------------------------------------------------------------ thesis health

export interface WindowOptions {
  readonly since?: Instant | null;
  readonly windowDays?: number;
}

/**
 * Notes active at `at` and observed in the `windowDays` before it; with `since` only notes stored
 * at or after it.
 */
export function windowNotes(
  notes: Iterable<ScoredNote>,
  at: Instant,
  options: WindowOptions = {},
): ScoredNote[] {
  const start = at - BigInt(options.windowDays ?? HEALTH_WINDOW_DAYS) * MICROS_PER_DAY;
  const since = options.since ?? null;
  const out: ScoredNote[] = [];
  for (const n of notes) {
    if (
      activeAt(n, at) &&
      n.observedAt >= start &&
      (since === null || n.createdAt >= since) &&
      n.kind !== CANDIDATE_KIND
    ) {
      out.push(n);
    }
  }
  return out;
}

export interface RelationCounts {
  supports: number;
  weakens: number;
  invalidates: number;
  fulfills: number;
  neutral: number;
  community: number;
}

export function emptyCounts(): RelationCounts {
  return { supports: 0, weakens: 0, invalidates: 0, fulfills: 0, neutral: 0, community: 0 };
}

const COUNTED = new Set(["supports", "weakens", "invalidates", "fulfills", "neutral", "community"]);

export function relationCounts(notes: Iterable<ScoredNote>): RelationCounts {
  const counts = emptyCounts();
  for (const note of notes) {
    if (COUNTED.has(note.thesisRelation)) counts[note.thesisRelation as keyof RelationCounts] += 1;
    if (note.kind === COMMUNITY_KIND) counts.community += 1;
  }
  return counts;
}

export function strongestRelation(notes: Iterable<ScoredNote>): string {
  let best = "none";
  for (const note of notes) {
    if ((RELATION_RANK.get(note.thesisRelation) ?? 0) > (RELATION_RANK.get(best) as number)) {
      best = note.thesisRelation;
    }
  }
  return best;
}

export interface HealthResult {
  readonly state: Health;
  readonly counts: RelationCounts;
  /** The strongest thesis relation among the window's notes. */
  readonly relation: string;
  /** The window's notes that bear on the thesis, newest first. */
  readonly noteIds: readonly number[];
  /**
   * Every note deciding the state (the notes of the winning relation) was stored before the
   * thesis' last core change: the state rests on research older than the current thesis (P2).
   */
  readonly predatesThesis: boolean;
}

/** The relation whose notes decide each note-driven health state. */
export const DECIDING_RELATION: ReadonlyMap<string, string> = new Map([
  ["invalidated", "invalidates"],
  ["weakened", "weakens"],
  ["fulfilled", "fulfills"],
  ["supported", "supports"],
]);

/** The note was stored before the thesis' last core change (tagged, never dropped; P2). */
export function predates(note: ScoredNote, coreChangedAt: Instant | null | undefined): boolean {
  return coreChangedAt !== undefined && coreChangedAt !== null && note.createdAt < coreChangedAt;
}

export interface HealthOptions {
  readonly hasThesis: boolean;
  /** The thesis' last core change as of `at`; it never filters notes (P2). */
  readonly thesisChangedAt?: Instant | null;
  /** A research run covered the instrument in the window (a note in the window counts too). */
  readonly researched?: boolean;
}

/** Health of one position at `at` from its notes. */
export function thesisHealth(
  notes: Iterable<ScoredNote>,
  at: Instant,
  options: HealthOptions,
): HealthResult {
  const all = Array.from(notes);
  if (!options.hasThesis) {
    const counted = windowNotes(all, at);
    return {
      state: Health.NO_THESIS,
      counts: relationCounts(counted),
      relation: "none",
      noteIds: [],
      predatesThesis: false,
    };
  }
  const counted = windowNotes(all, at);
  const counts = relationCounts(counted);
  const relation = strongestRelation(counted);
  // Python: sorted(key=(observed_at, id), reverse=True) keeps equal keys in their original order.
  const bearing = counted
    .filter((n) => BEARING_RELATIONS.includes(n.thesisRelation))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      if (a.n.observedAt !== b.n.observedAt) return a.n.observedAt > b.n.observedAt ? -1 : 1;
      if (a.n.id !== b.n.id) return b.n.id - a.n.id;
      return a.i - b.i;
    })
    .map(({ n }) => n);
  let state: Health;
  if (counts.invalidates) state = Health.INVALIDATED;
  else if (counts.weakens) state = Health.WEAKENED;
  else if (counts.fulfills) state = Health.FULFILLED;
  else if (counts.supports) state = Health.SUPPORTED;
  else if (options.researched || windowNotes(all, at).length > 0) state = Health.CURRENT;
  else state = Health.NO_RESEARCH;
  const decidingRelation = DECIDING_RELATION.get(state);
  const deciding = counted.filter((n) => n.thesisRelation === decidingRelation);
  const old =
    deciding.length > 0 && deciding.every((n) => predates(n, options.thesisChangedAt ?? null));
  return { state, counts, relation, noteIds: bearing.map((n) => n.id), predatesThesis: old };
}

/** Position of `state` in `HEALTH_ORDER` (0 = most attention; unknown states last). */
export function healthRank(state: string): number {
  const i = HEALTH_ORDER.indexOf(state as Health);
  return i < 0 ? HEALTH_ORDER.length : i;
}
