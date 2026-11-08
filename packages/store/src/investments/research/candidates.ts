// Candidate accept / undo (Python `research/service.py` `accept_candidate` / `undo_accept`):
// `Obserwuj` puts the candidate on the watchlist (source user, note `kandydat: <title>`; a watched
// instrument is kept, a removed row comes back) and writes a draft thesis when the instrument has
// none; undo within 15 minutes takes back what the accept created or restored.
//
// One batch each (events.md 8.9, 6.6): `note.candidateUpdated` first, then the `watchlist.*` /
// `thesis.*` side events with `cause` = its eid. The note's `details` keep gids (watchlist row,
// thesis, previous instrument; gid.md 6).
//
// Resolution of a candidate that names a symbol the vault does not hold yet (Python
// `watch_service.add(symbol)`: a stored instrument by ISIN / alias / symbol + market, else a new one,
// with remote search or chart verification) is network IO that happens before the first write, so
// the caller resolves or creates the instrument first (the watchlist resolver, S22b) and passes its
// gid as `instrument`; a candidate whose note already names a vault instrument needs nothing.
import { research } from "@cashu/domain/investments";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { eventBlob, gid } from "../../events/v1/primitives.js";
import { watchlist, watchRowFor } from "../queries/alerts.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { theses, thesisByGid } from "../queries/journal.js";
import { instrumentGid } from "../queries/shared.js";
import { nowOf } from "./commands.js";
import { noteByGid, RESTORE_WINDOW } from "./queries.js";
import { truthy, viewInstant } from "./rows.js";

/** Python `watch_service.MAX_NOTE_LENGTH` / `MAX_ITEMS`. */
export const WATCH_NOTE_MAX = 1000;
export const WATCHLIST_MAX = 200;
export const DRAFT_THESIS_PREFIX = "Szkic z researchu: ";
export const DRAFT_THESIS_PREFIX_EN = "Research draft: ";
/** A new draft starts with the UI language's prefix; undo recognises either. */
export const DRAFT_THESIS_PREFIXES: readonly string[] = [
  DRAFT_THESIS_PREFIX,
  DRAFT_THESIS_PREFIX_EN,
];

/** The accept bookkeeping keys of `details` (removed again by an undo). */
export const ACCEPT_KEYS: readonly string[] = [
  "accepted_at",
  "watchlist_item_id",
  "thesis_id",
  "created_watchlist_item",
  "restored_watchlist_item",
  "previous_watchlist_note",
  "accepted_watchlist_note",
  "created_thesis",
  "previous_instrument_id",
];

/** The first `n` code points of `s` (Python slicing). */
const head = (s: string, n: number) => [...s].slice(0, n).join("");

export interface AcceptResult {
  readonly note: string;
  /** The watchlist row (its gid). */
  readonly watchlistItem: string;
  readonly thesis: string | null;
  readonly createdThesis: boolean;
}

export const acceptCandidate = defineCommand({
  id: "investments.research.acceptCandidate",
  input: z.object({
    note: gid,
    /** The resolved instrument of a candidate whose note names none in this vault (see the header). */
    instrument: gid.nullable().default(null),
    lang: z.enum(["pl", "en"]).default("pl"),
  }),
  run(ctx, input) {
    const now = nowOf(ctx);
    const row = noteByGid(ctx.read, input.note);
    if (row === undefined) return refuse("no_note");
    if (row.kind !== research.CANDIDATE_KIND) return refuse("not_candidate");
    if (row.dismissedAt !== null) return refuse("candidate_dismissed");
    const details: Record<string, unknown> = { ...(row.details ?? {}) };
    if (truthy(details.accepted_at)) return refuse("candidate_accepted");

    let instrument: string;
    if (row.instrument !== null && vaultInstrumentGids(ctx.read).has(row.instrument)) {
      instrument = row.instrument;
    } else {
      const candidate = (details.candidate ?? {}) as Record<string, unknown>;
      if (!candidate.symbol && !row.candidateKey) return refuse("candidate_without_symbol");
      if (input.instrument === null) return refuse("unresolved_instrument");
      const resolved = instrumentGid(ctx.read, input.instrument);
      if (resolved === undefined) return refuse("no_instrument");
      instrument = resolved;
    }

    // Python `watch_service.add(..., keep_existing_note=True)`, or the watched row as it is.
    const existing = watchRowFor(ctx.read, instrument);
    const watchNote = head(`kandydat: ${row.title}`, WATCH_NOTE_MAX).trim() || null;
    let item: string;
    let createdItem = false;
    let restoredItem = false;
    let previousNote: string | null = null;
    let acceptedNote: string | null = null;
    let addWatch: Record<string, unknown> | null = null;
    if (existing !== undefined && existing.removedAt === null) {
      item = existing.gid;
    } else {
      if (watchlist(ctx.read).length >= WATCHLIST_MAX) return refuse("watchlist_full");
      const keepNote = Boolean(existing?.note);
      addWatch = { instrument, source: "user", ...(keepNote ? {} : { note: watchNote }) };
      if (existing !== undefined) {
        item = existing.gid;
        restoredItem = true;
        previousNote = existing.note;
        acceptedNote = keepNote ? existing.note : watchNote;
      } else {
        item = ctx.det("watchlist_items", [instrument]);
        createdItem = true;
        acceptedNote = watchNote;
      }
    }

    const own = theses(ctx.read, instrument);
    const thesis = own[0]?.gid ?? ctx.newGid();
    const createdThesis = own.length === 0;
    const prefix = input.lang === "en" ? DRAFT_THESIS_PREFIX_EN : DRAFT_THESIS_PREFIX;
    const entryType =
      typeof details.entry_type === "string" && details.entry_type ? details.entry_type : "trend";

    Object.assign(details, {
      accepted_at: research.formatInstant(now),
      watchlist_item_id: item,
      thesis_id: thesis,
      created_watchlist_item: createdItem,
      restored_watchlist_item: restoredItem,
      previous_watchlist_note: previousNote,
      accepted_watchlist_note: acceptedNote,
      created_thesis: createdThesis,
      previous_instrument_id: row.instrument,
    });
    const cause = ctx.emit("note.candidateUpdated", row.gid, {
      instrument,
      ...eventBlob("details", details),
    });
    if (addWatch !== null) {
      ctx.emit("watchlist.added", ctx.det("watchlist_items", [instrument]), addWatch, { cause });
    }
    if (createdThesis) {
      ctx.emit(
        "thesis.created",
        thesis,
        {
          instrument,
          entryType,
          thesis: head(prefix + row.title, 500),
          invalidation: null,
          exitPlan: null,
          sizePlan: null,
        },
        { cause },
      );
    }
    return ok<AcceptResult>({ note: row.gid, watchlistItem: item, thesis, createdThesis });
  },
});

export const undoAcceptCandidate = defineCommand({
  id: "investments.research.undoAccept",
  input: z.object({ note: gid }),
  /**
   * Python `undo_accept` within 15 minutes: the watchlist row the accept created or restored is
   * removed again (a restored row gets its previous note back unless the owner edited it since), the
   * draft thesis it created goes away unless edited since, the candidate is open again.
   */
  run(ctx, input) {
    const now = nowOf(ctx);
    const row = noteByGid(ctx.read, input.note);
    if (row === undefined) return refuse("no_note");
    const details: Record<string, unknown> = { ...(row.details ?? {}) };
    const accepted = details.accepted_at;
    if (row.kind !== research.CANDIDATE_KIND || !truthy(accepted)) return refuse("not_accepted");
    const at = research.parseMoment(String(accepted));
    if (at === null || now - at > RESTORE_WINDOW) return refuse("undo_expired");

    const side: { type: string; gid: string; data: Record<string, unknown> }[] = [];
    const instrument = row.instrument;
    if (
      (truthy(details.created_watchlist_item) || truthy(details.restored_watchlist_item)) &&
      truthy(details.watchlist_item_id) &&
      instrument !== null
    ) {
      const watched = watchRowFor(ctx.read, instrument);
      if (
        watched !== undefined &&
        watched.gid === details.watchlist_item_id &&
        watched.removedAt === null
      ) {
        const member = ctx.det("watchlist_items", [instrument]);
        side.push({ type: "watchlist.removed", gid: member, data: {} });
        if (
          truthy(details.restored_watchlist_item) &&
          watched.note === (details.accepted_watchlist_note ?? null)
        ) {
          const previous = details.previous_watchlist_note;
          side.push({
            type: "watchlist.updated",
            gid: member,
            data: { note: typeof previous === "string" ? previous : null },
          });
        }
      }
    }
    if (truthy(details.created_thesis) && typeof details.thesis_id === "string") {
      const t = thesisByGid(ctx.read, details.thesis_id);
      const untouched =
        t !== undefined &&
        viewInstant(t.updatedAt) <= viewInstant(t.createdAt) + research.MICROS_PER_SECOND;
      if (untouched && DRAFT_THESIS_PREFIXES.some((p) => t.thesis.startsWith(p))) {
        side.push({ type: "thesis.deleted", gid: t.gid, data: {} });
      }
    }
    const previous = details.previous_instrument_id;
    for (const k of ACCEPT_KEYS) delete details[k];
    const cause = ctx.emit("note.candidateUpdated", row.gid, {
      instrument: typeof previous === "string" ? previous : null,
      ...(Object.keys(details).length > 0 ? eventBlob("details", details) : { details: null }),
    });
    for (const e of side) ctx.emit(e.type, e.gid, e.data, { cause });
    return ok({ note: row.gid });
  },
});
