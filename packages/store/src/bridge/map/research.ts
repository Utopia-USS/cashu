// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the watchlist, topic theses, research runs and notes (S31a spec 4.4 table; events.md
// 8.9; S25-python-emits F4 / F5). Inserts are the genesis snapshot (`mapWatchlist`,
// `mapTopicThesis`, `mapResearchRun`, `mapNote`); updates take every payload field from the genesis
// snapshot of `post`:
// - watchlist: `note` / `tags` -> `watchlist.updated` (changed only); `removed_at` set ->
//   `watchlist.removed`; cleared (a re-add, `service/watchlist.py:add`) -> `watchlist.added` with
//   instrument and source, note / tags only when given (M2: absent = keep);
// - topic theses (`research/topic_theses.py`): a write -> `ownerSaved` (post not a draft) or
//   `draftProposed` (post a draft: only the agent keeps a row a draft), invalidation absent when the
//   agent kept it; the market view -> `marketViewSet` (sources only when they changed); `rejected_at`
//   set -> `rejected`; a write on a rejected row (`rejected_at` cleared) is a restart, whose cleared
//   view the reducer clears itself;
// - research runs: running -> done / failed -> `researchRun.finished`;
// - notes: `details` / `instrument_id` -> `note.candidateUpdated` (both whole, an unchanged
//   instrument filled from post); `signal_id` -> `note.signalLinked`; `read_at` -> `note.read`;
//   `dismissed_at` set -> `note.dismissed`, cleared -> `note.restored`.
import type { EventType } from "../../events/v1/catalog.js";
import type {
  InvTopicThesisRow,
  ResearchNoteRow,
  ResearchRunRow,
  WatchlistItemRow,
} from "../../genesis/invStateRows.js";
import type { EventDraft, MapContext } from "../../genesis/map/context.js";
import {
  mapNote,
  mapResearchRun,
  mapTopicThesis,
  mapWatchlist,
} from "../../genesis/map/research.js";
import {
  anyChanged,
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  fieldsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

function need<R>(row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock("decode");
  return row;
}

/** A change of a column the catalog has no update event for: block, never ship it half. */
function refuseChanged(change: RowChange<unknown>, table: string, columns: readonly string[]) {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

/**
 * A reference the genesis mapper takes as guaranteed (`requiredGid` throws a plain error on a miss):
 * checked first so an unresolved one blocks the loop instead of crashing it.
 */
function requireRef(ctx: MapContext, owner: string, table: string, localId: number): void {
  if (ctx.ids.resolver.gid(table, String(localId)) === undefined) {
    throw new BridgeBlock(`unresolved:${owner}`);
  }
}

// ----------------------------------------------------------------------------------------------- //
// Watchlist

const WATCHLIST = "watchlist_items";
/** Python column -> optional `watchlist.added` / `watchlist.updated` field. */
const WATCH_TEXT: readonly (readonly [string, string])[] = [
  ["note", "note"],
  ["tags", "tags"],
];

function watchSnapshot(row: WatchlistItemRow, ctx: MapContext): readonly EventDraft[] {
  requireRef(ctx, WATCHLIST, "inv_instruments", row.instrumentId);
  return eventsOf(
    WATCHLIST,
    ctx.attempt(() => mapWatchlist(row, ctx)),
  );
}

function watchUpdate(c: RowChange<WatchlistItemRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, WATCHLIST, ["instrument_id"]);
  const post = need(c.post);
  const pre = need(c.pre);
  const snap = watchSnapshot(post, ctx);
  const added = pick(WATCHLIST, snap, "watchlist.added");
  const text = WATCH_TEXT.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  const readded = pre.removedAt !== null && post.removedAt === null;
  if (c.changed.has("source") && !readded) throw new BridgeBlock(`immutable:${WATCHLIST}:source`);
  const out: EventDraft[] = [];
  if (readded) {
    const keys = ["instrument", ...text, "source"];
    out.push(derived(added, "watchlist.added", fieldsOf(added.data, keys)));
  } else if (text.length > 0) {
    out.push(derived(added, "watchlist.updated", fieldsOf(added.data, text)));
  }
  if (c.changed.has("removed_at") && post.removedAt !== null) {
    out.push(pick(WATCHLIST, snap, "watchlist.removed"));
  }
  return out;
}

const watchlist: TableBridge<WatchlistItemRow> = {
  table: WATCHLIST,
  gid: "det",
  columns: {
    ...carried(["watchlist.added"], "id", "profile_id", "instrument_id", "source"),
    ...carried(["watchlist.added", "watchlist.updated"], "note", "tags"),
    ...carried(["watchlist.removed", "watchlist.added"], "removed_at"),
  },
  insert: (c, ctx) => watchSnapshot(need(c.post), ctx),
  update: watchUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Topic theses

const TOPICS = "inv_topic_theses";
/** Columns a thesis write (`_write`) changes: carried by `ownerSaved` / `draftProposed`. */
const TOPIC_TEXT = ["thesis", "invalidation", "draft", "created_by", "created_at"];
const TOPIC_VIEW = ["assessment", "outlook", "view_sources"];
/** The view writer genesis names (D-G8): Python keeps no record of who wrote a market view. */
const VIEW_WRITER = "agent";

function topicSnapshot(row: InvTopicThesisRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    TOPICS,
    ctx.attempt(() => mapTopicThesis(row, ctx)),
  );
}

/** The write event of a thesis write; `draftProposed` without invalidation when the agent kept it. */
function topicWrite(
  c: RowChange<InvTopicThesisRow>,
  snap: readonly EventDraft[],
  post: InvTopicThesisRow,
  restart: boolean,
): EventDraft {
  if (!post.draft) return pick(TOPICS, snap, "topicThesis.ownerSaved");
  const full = pick(TOPICS, snap, "topicThesis.draftProposed");
  if (restart || c.changed.has("invalidation")) return full;
  return derived(full, "topicThesis.draftProposed", fieldsOf(full.data, ["segment", "thesis"]));
}

/** The market view event; a view cleared of both texts has no genesis event (built from the write). */
function topicView(
  c: RowChange<InvTopicThesisRow>,
  snap: readonly EventDraft[],
  restart: boolean,
): EventDraft | undefined {
  const withSources = restart || c.changed.has("view_sources");
  const view = snap.find((e) => e.type === "topicThesis.marketViewSet");
  if (view !== undefined) {
    if (withSources) return view;
    const keys = ["segment", "assessment", "outlook", "by"];
    return derived(view, "topicThesis.marketViewSet", fieldsOf(view.data, keys));
  }
  // A restart already cleared the view (events.md 8.9): nothing to ship.
  if (restart) return undefined;
  const base = snap[0];
  if (base === undefined) throw new BridgeBlock(`unresolved:${TOPICS}`);
  return derived(base, "topicThesis.marketViewSet", {
    ...fieldsOf(base.data, ["segment"]),
    assessment: null,
    outlook: null,
    ...(withSources ? { sources: null } : {}),
    by: VIEW_WRITER,
  });
}

function topicUpdate(c: RowChange<InvTopicThesisRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, TOPICS, ["segment"]);
  const post = need(c.post);
  const pre = need(c.pre);
  const snap = topicSnapshot(post, ctx);
  const restart = pre.rejectedAt !== null && post.rejectedAt === null;
  const out: EventDraft[] = [];
  if (restart || anyChanged(c, ...TOPIC_TEXT)) out.push(topicWrite(c, snap, post, restart));
  if (anyChanged(c, ...TOPIC_VIEW)) {
    const view = topicView(c, snap, restart);
    if (view !== undefined) out.push(view);
  }
  if (pre.rejectedAt === null && post.rejectedAt !== null) {
    out.push(pick(TOPICS, snap, "topicThesis.rejected"));
  }
  return out;
}

const WRITES: readonly EventType[] = ["topicThesis.ownerSaved", "topicThesis.draftProposed"];

const topicTheses: TableBridge<InvTopicThesisRow> = {
  table: TOPICS,
  gid: "det",
  columns: {
    ...carried(WRITES, "id", "profile_id", "segment", ...TOPIC_TEXT),
    ...carried(["topicThesis.rejected", ...WRITES], "rejected_at"),
    ...carried(["topicThesis.marketViewSet", ...WRITES], ...TOPIC_VIEW),
  },
  insert: (c, ctx) => topicSnapshot(need(c.post), ctx),
  update: topicUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Research runs

const RUNS = "research_runs";
const FINISHED: readonly string[] = ["done", "failed"];

function runSnapshot(row: ResearchRunRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    RUNS,
    ctx.attempt(() => mapResearchRun(row, ctx)),
  );
}

function runUpdate(c: RowChange<ResearchRunRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, RUNS, ["scope", "created_by", "started_at"]);
  if (!anyChanged(c, "status", "finished_at", "counts")) return [];
  const post = need(c.post);
  if (!FINISHED.includes(post.status)) throw new BridgeBlock(`immutable:${RUNS}:status`);
  return [pick(RUNS, runSnapshot(post, ctx), "researchRun.finished")];
}

const researchRuns: TableBridge<ResearchRunRow> = {
  table: RUNS,
  gid: "ulid",
  columns: {
    ...carried(["researchRun.started"], "id", "profile_id", "started_at", "scope", "created_by"),
    ...carried(["researchRun.started", "researchRun.finished"], "status", "finished_at", "counts"),
  },
  insert: (c, ctx) => runSnapshot(need(c.post), ctx),
  update: runUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Research notes

const NOTES = "research_notes";
/** Columns no Python writer changes after the insert. */
const NOTE_FIXED = [
  "run_id",
  "theme",
  "segment",
  "kind",
  "polarity",
  "strength",
  "thesis_relation",
  "thesis_field",
  "title",
  "summary",
  "sources",
  "candidate_key",
  "observed_at",
  "expires_at",
  "created_by",
  "created_at",
];

function noteSnapshot(row: ResearchNoteRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    NOTES,
    ctx.attempt(() => mapNote(row, ctx)),
  );
}

function noteUpdate(c: RowChange<ResearchNoteRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, NOTES, NOTE_FIXED);
  const post = need(c.post);
  const pre = need(c.pre);
  const snap = noteSnapshot(post, ctx);
  const added = pick(NOTES, snap, "note.added");
  const out: EventDraft[] = [];
  // S25-F4: candidate accept / undo; the instrument is whole even when only details changed.
  if (anyChanged(c, "details", "instrument_id")) {
    const data = fieldsOf(added.data, ["instrument", "details"]);
    out.push(derived(added, "note.candidateUpdated", data));
  }
  // S25-F5: the research sync re-points a note at its episode's signal (never to none).
  if (c.changed.has("signal_id")) {
    if (post.signalId === null) throw new BridgeBlock(`immutable:${NOTES}:signal_id`);
    out.push(derived(added, "note.signalLinked", fieldsOf(added.data, ["signal"])));
  }
  if (c.changed.has("read_at")) {
    if (post.readAt === null) throw new BridgeBlock(`immutable:${NOTES}:read_at`);
    // Genesis emits `note.read` for agent notes only (owner notes are born read).
    out.push(snap.find((e) => e.type === "note.read") ?? derived(added, "note.read", {}));
  }
  const dismissMoved = c.changed.has("dismissed_at");
  if (c.changed.has("cooldown_until") && !dismissMoved) {
    throw new BridgeBlock(`immutable:${NOTES}:cooldown_until`);
  }
  if (dismissMoved && post.dismissedAt !== null) out.push(pick(NOTES, snap, "note.dismissed"));
  if (dismissMoved && pre.dismissedAt !== null && post.dismissedAt === null) {
    out.push(derived(added, "note.restored", {}));
  }
  return out;
}

const DISMISS: readonly EventType[] = ["note.dismissed", "note.restored"];

const researchNotes: TableBridge<ResearchNoteRow> = {
  table: NOTES,
  gid: "ulid",
  columns: {
    ...carried(["note.added"], "id", "profile_id", ...NOTE_FIXED),
    ...carried(["note.added", "note.candidateUpdated"], "instrument_id", "details"),
    ...carried(["note.added", "note.signalLinked"], "signal_id"),
    ...carried(["note.added", "note.read"], "read_at"),
    ...carried(["note.added", ...DISMISS], "dismissed_at", "cooldown_until"),
  },
  insert: (c, ctx) => noteSnapshot(need(c.post), ctx),
  update: noteUpdate,
};

export const researchBridges: readonly TableBridge[] = [
  watchlist,
  topicTheses,
  researchRuns,
  researchNotes,
];
