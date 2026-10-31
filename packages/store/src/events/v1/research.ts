// Watchlist, topic theses, research runs and notes payloads (events.md 8.9, watchlist in 8.1).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import { gid, jsonObject, nonEmpty, timestamp } from "./primitives.js";
import { POLARITIES } from "./signals.js";

/** Limits of investments.models (validated at emit time by the services; mirrored here). */
export const TOPIC_THESIS_MAX = 600;
export const TOPIC_INVALIDATION_MAX = 400;
export const TOPIC_MARKET_VIEW_MAX = 400;
export const RESEARCH_TITLE_MAX = 120;
export const RESEARCH_SUMMARY_MAX = 1200;
export const RESEARCH_RUN_FINISH_STATUSES = ["done", "failed"] as const;
export const RESEARCH_NOTE_KINDS = [
  "news",
  "earnings",
  "community",
  "trend",
  "macro",
  "candidate",
] as const;
export const RESEARCH_THESIS_RELATIONS = [
  "supports",
  "weakens",
  "invalidates",
  "fulfills",
  "neutral",
  "none",
] as const;
export const RESEARCH_THESIS_FIELDS = [
  "entry_type",
  "thesis",
  "invalidation",
  "exit_plan",
  "size_plan",
] as const;
export const RESEARCH_CREATORS = ["agent", "user"] as const;
export const TOPIC_WRITERS = ["owner", "agent"] as const;
export const WATCHLIST_SOURCES = ["user", "agent"] as const;

const segmentKey = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "expected a segment catalog key");
const source = z.looseObject({
  title: z.string(),
  url: z.string(),
  publisher: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
});

export const researchEvents = {
  "watchlist.added": payload({
    instrument: gid,
    note: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    source: z.enum(WATCHLIST_SOURCES),
  }),
  "watchlist.updated": patchOf({ note: z.string().nullable(), tags: z.array(z.string()) }),
  "watchlist.removed": empty,

  "topicThesis.ownerSaved": payload({
    segment: segmentKey,
    thesis: z.string().min(1).max(TOPIC_THESIS_MAX),
    invalidation: z.string().max(TOPIC_INVALIDATION_MAX).nullable(),
  }),
  /** `invalidation` absent = keep the stored one (topic_theses.upsert_draft), null = clear. */
  "topicThesis.draftProposed": payload({
    segment: segmentKey,
    thesis: z.string().min(1).max(TOPIC_THESIS_MAX),
    invalidation: z.string().max(TOPIC_INVALIDATION_MAX).nullable().optional(),
  }),
  "topicThesis.rejected": empty,
  "topicThesis.marketViewSet": payload({
    segment: segmentKey,
    assessment: z.string().max(TOPIC_MARKET_VIEW_MAX).nullable(),
    outlook: z.string().max(TOPIC_MARKET_VIEW_MAX).nullable(),
    /** Absent = keep the stored sources (Python KEEP), null = clear. */
    sources: z.array(source).max(6).nullable().optional(),
    by: z.enum(TOPIC_WRITERS),
  }),

  "researchRun.started": payload({
    scope: jsonObject,
    createdBy: z.enum(RESEARCH_CREATORS),
  }),
  "researchRun.finished": payload({
    status: z.enum(RESEARCH_RUN_FINISH_STATUSES),
    counts: jsonObject,
  }),

  "note.added": payload({
    run: gid.nullable(),
    instrument: gid.nullable(),
    theme: z.string().nullable(),
    segment: segmentKey.nullable(),
    kind: z.enum(RESEARCH_NOTE_KINDS),
    polarity: z.enum(POLARITIES),
    strength: z.int().min(1).max(3),
    thesisRelation: z.enum(RESEARCH_THESIS_RELATIONS),
    thesisField: z.enum(RESEARCH_THESIS_FIELDS).nullable(),
    title: nonEmpty.max(RESEARCH_TITLE_MAX),
    summary: z.string().max(RESEARCH_SUMMARY_MAX),
    sources: z.array(source),
    details: jsonObject.nullable(),
    candidateKey: z.string().nullable(),
    signal: gid.nullable(),
    observedAt: timestamp,
    expiresAt: timestamp,
    createdBy: z.enum(RESEARCH_CREATORS),
  }),
  "note.read": empty,
  "note.dismissed": payload({ cooldownUntil: timestamp.nullable() }),
  "note.restored": empty,
  /**
   * Candidate accept / undo (S25-F4): replaces the note's instrument and details as whole values
   * (LWW-F), emitted in the accept / undo batch with the watchlist / thesis events.
   */
  "note.candidateUpdated": payload({
    instrument: gid.nullable(),
    details: jsonObject.nullable(),
  }),
  /** The research sync re-points a lead note at the episode's signal (S25-F5). */
  "note.signalLinked": payload({ signal: gid }),
} as const;
