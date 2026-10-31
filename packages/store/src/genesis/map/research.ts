// Genesis row mappers, watchlist, topic theses and research (S26 spec 4.9, D-G8, D-G9; events.md
// 8.9): soft-deleted rows keep their deletion state, topic theses keep owner / agent authorship and
// their market view, research runs and notes keep their read / dismissed state.
import type {
  InvTopicThesisRow,
  ResearchNoteRow,
  ResearchRunRow,
  WatchlistItemRow,
} from "../invStateRows.js";
import {
  type EventDraft,
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

/** `watchlist.added` (note and tags always present), then `watchlist.removed` for a removed item. */
export function mapWatchlist(r: WatchlistItemRow, ctx: MapContext): RowEvents | undefined {
  const t = "watchlist_items";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, ["addedAt", "removedAt"]);
  const data = {
    instrument: requiredGid(ctx, "inv_instruments", r.instrumentId),
    note: r.note,
    tags: ctx.rw.json(t, "tags", r.tags),
    source: r.source,
  };
  const events = [event("watchlist.added", gid, data, stamps)];
  if (r.removedAt !== null) events.push(event("watchlist.removed", gid, {}, stamps));
  return rowEvents(t, r.id, events);
}

const TOPIC_STAMPS = [
  "createdAt",
  "updatedAt",
  "coreChangedAt",
  "rejectedAt",
  "viewUpdatedAt",
] as const;

/**
 * A draft: `draftProposed`; an owner thesis: `ownerSaved`; an agent thesis the owner accepted:
 * `draftProposed` then `ownerSaved` (same texts). Then the market view (`by = "agent"`, D-G8) and,
 * last, `rejected`. A writer outside owner / agent is `bad_enum`.
 */
export function mapTopicThesis(r: InvTopicThesisRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_topic_theses";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  if (r.createdBy !== "owner" && r.createdBy !== "agent") {
    ctx.count(t, "bad_enum");
    return undefined;
  }
  const stamps = stampsOf(r, TOPIC_STAMPS);
  const texts = { segment: r.segment, thesis: r.thesis, invalidation: r.invalidation };
  const events: EventDraft[] = [];
  if (r.draft || r.createdBy === "agent") {
    events.push(event("topicThesis.draftProposed", gid, texts, stamps));
  }
  if (!r.draft) events.push(event("topicThesis.ownerSaved", gid, texts, stamps));
  if (r.assessment !== null || r.outlook !== null || r.viewSources !== null) {
    const view = {
      segment: r.segment,
      assessment: r.assessment,
      outlook: r.outlook,
      sources: ctx.rw.json(t, "view_sources", r.viewSources),
      by: "agent",
    };
    events.push(event("topicThesis.marketViewSet", gid, view, stamps));
  }
  if (r.rejectedAt !== null) events.push(event("topicThesis.rejected", gid, {}, stamps));
  return rowEvents(t, r.id, events);
}

/**
 * `researchRun.started`, then `researchRun.finished` for a done / failed run; a running run stays
 * started (D-G9, counted `run_running`), another status is `bad_enum`.
 */
export function mapResearchRun(r: ResearchRunRow, ctx: MapContext): RowEvents | undefined {
  const t = "research_runs";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  if (r.status !== "running" && r.status !== "done" && r.status !== "failed") {
    ctx.count(t, "bad_enum");
    return undefined;
  }
  const stamps = stampsOf(r, ["startedAt", "finishedAt"]);
  const started = { scope: ctx.rw.json(t, "scope", r.scope), createdBy: r.createdBy };
  const events = [event("researchRun.started", gid, started, stamps)];
  if (r.status === "running") {
    ctx.count(t, "run_running");
  } else {
    const finished = { status: r.status, counts: ctx.rw.json(t, "counts", r.counts) };
    events.push(event("researchRun.finished", gid, finished, stamps));
  }
  return rowEvents(t, r.id, events);
}

/** A digits-only candidate key: a local instrument id, not an ISIN or a symbol. */
const LOCAL_ID = /^[0-9]+$/;

const NOTE_STAMPS = [
  "createdAt",
  "updatedAt",
  "observedAt",
  "expiresAt",
  "readAt",
  "dismissedAt",
  "cooldownUntil",
] as const;

/**
 * `note.added` (stamps include `read_at` and `dismissed_at`, so an owner note born read keeps its
 * read time), `note.read` for an agent note the owner read (spec 4.9) and `note.dismissed`.
 * Counts `(research_notes, candidate_key_local_id)`.
 */
export function mapNote(r: ResearchNoteRow, ctx: MapContext): RowEvents | undefined {
  const t = "research_notes";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  // Python's candidate fallback `str(instrument_id)` (research/service.py) stores a local id as the
  // key; it is copied verbatim but counted, and fails a strict run (S26 review F6).
  if (r.candidateKey !== null && LOCAL_ID.test(r.candidateKey)) {
    ctx.count(t, "candidate_key_local_id");
  }
  const stamps = stampsOf(r, NOTE_STAMPS);
  const data = {
    run: ctx.rw.ref(t, "run_id", "research_runs", r.runId),
    instrument: ctx.rw.ref(t, "instrument_id", "inv_instruments", r.instrumentId),
    theme: r.theme,
    segment: r.segment,
    kind: r.kind,
    polarity: r.polarity,
    strength: r.strength,
    thesisRelation: r.thesisRelation,
    thesisField: r.thesisField,
    title: r.title,
    summary: r.summary,
    sources: ctx.rw.json(t, "sources", r.sources),
    details: ctx.rw.json(t, "details", r.details),
    candidateKey: r.candidateKey,
    signal: ctx.rw.ref(t, "signal_id", "inv_signals", r.signalId),
    observedAt: r.observedAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
  };
  const events = [event("note.added", gid, data, stamps)];
  if (r.readAt !== null && r.createdBy === "agent") {
    events.push(event("note.read", gid, {}, stamps));
  }
  if (r.dismissedAt !== null) {
    events.push(event("note.dismissed", gid, { cooldownUntil: r.cooldownUntil }, stamps));
  }
  return rowEvents(t, r.id, events);
}
