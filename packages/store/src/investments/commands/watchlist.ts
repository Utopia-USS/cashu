// Watchlist commands (Python `service/watchlist.py`, write side): put an instrument on the watchlist
// (one the vault references, a stored one the service resolved, or a planned new one stored in the
// same batch), edit an item's note / tags, take it off (SOFT). One row per instrument forever (F12):
// adding a removed instrument restores its row with the same gid; note / tags change only when given
// (events.md 8.9, M2). Resolution and every network call live in `services/watchlist.ts`.
import { pyLen, pyStrip } from "@cashu/domain/text";
import { z } from "zod";
import {
  type CommandContext,
  type CommandResult,
  defineCommand,
  ok,
  refuse,
} from "../../command.js";
import { gid } from "../../events/v1/primitives.js";
import { WATCHLIST_SOURCES } from "../../events/v1/research.js";
import { watchlist, watchlistItem, watchRowFor } from "../queries/alerts.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentGid } from "../queries/shared.js";
import { plannedHolder } from "../queries/watchlist.js";
import { instrumentSpec, storeInstrument } from "./instruments.js";

/** Most live watchlist items per vault (each one costs a price fetch in every daily run). */
export const MAX_ITEMS = 200;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;
export const MAX_NOTE_LENGTH = 1000;

/**
 * Python `_note`: at most MAX_NOTE_LENGTH characters (counted before stripping, `note_too_long`);
 * stripped, a blank note is null.
 */
export function cleanNote(note: string): CommandResult<string | null> {
  if (pyLen(note) > MAX_NOTE_LENGTH) return refuse("note_too_long");
  return ok(pyStrip(note) || null);
}

/**
 * Python `_tags`: stripped, blanks dropped, duplicates dropped (first kept); at most MAX_TAGS
 * (`too_many_tags`) of at most MAX_TAG_LENGTH characters each (`tag_too_long`).
 */
export function cleanTags(tags: readonly string[]): CommandResult<string[]> {
  const cleaned = [...new Set(tags.map(pyStrip).filter((t) => t !== ""))];
  if (cleaned.length > MAX_TAGS) return refuse("too_many_tags");
  if (cleaned.some((t) => pyLen(t) > MAX_TAG_LENGTH)) return refuse("tag_too_long");
  return ok(cleaned);
}

/** What an add watches: exactly one way to name the instrument. */
const watchTarget = z.union([
  /** Python `instrument_id`: an instrument the vault references (else `no_instrument`). */
  z.strictObject({ instrument: gid }),
  /** An instrument the service resolved from the view (Python `Resolution` of a stored one). */
  z.strictObject({ stored: gid }),
  /**
   * A new instrument the service resolved, stored in this batch. With `yahooSymbol` (Python
   * `_insert_once`): when another instrument holds that Yahoo alias, that one is watched instead.
   */
  z.strictObject({ planned: instrumentSpec, yahooSymbol: z.string().min(1).optional() }),
]);

const textList = z.array(z.string());

export interface WatchAddResult {
  /** The row gid (the same gid when a removed row came back). */
  readonly item: string;
  /** The watched instrument's root gid. */
  readonly instrument: string;
  readonly createdInstrument: boolean;
  /** True when the instrument's removed row came back instead of a new row. */
  readonly restored: boolean;
  /** The restored row's note before this add (research undo puts it back); null for a new row. */
  readonly previousNote: string | null;
  /** The item's note and tags after this add. */
  readonly note: string | null;
  readonly tags: readonly string[];
}

function resolveTarget(
  ctx: CommandContext,
  target: z.infer<typeof watchTarget>,
): { readonly gid: string; readonly created: boolean } | undefined {
  if ("planned" in target) {
    const held = plannedHolder(ctx.read, target.planned, target.yahooSymbol);
    if (held !== undefined) return { gid: held, created: false };
    return storeInstrument(ctx, target.planned);
  }
  if ("stored" in target) {
    const root = instrumentGid(ctx.read, target.stored);
    return root === undefined ? undefined : { gid: root, created: false };
  }
  const root = instrumentGid(ctx.read, target.instrument);
  if (root === undefined || !vaultInstrumentGids(ctx.read).has(root)) return undefined;
  return { gid: root, created: false };
}

export const addToWatchlist = defineCommand({
  id: "investments.addToWatchlist",
  input: z.object({
    target: watchTarget,
    /** Absent / null = not given (a restored row keeps its note); a blank note clears it. */
    note: z.string().nullable().optional(),
    /** Absent / null = not given (a restored row keeps its tags). */
    tags: textList.nullable().optional(),
    source: z.enum(WATCHLIST_SOURCES).default("user"),
    /** A restored row's non-empty note stays even when `note` is given (research accept). */
    keepExistingNote: z.boolean().default(false),
  }),
  /**
   * Python `add`: note / tags checked, then the item limit (live rows only; a restore counts like an
   * add), then the instrument, then `already_watched` (the caller finds the item with
   * `watchTargetInstrument` + `watchedItemFor`). A removed row comes back (`added_at` and `source` of
   * this add); its note / tags are replaced only when given.
   */
  run(ctx, input) {
    let note: string | null = null;
    if (input.note != null) {
      const checked = cleanNote(input.note);
      if (!checked.ok) return checked;
      note = checked.value;
    }
    let tags: string[] | null = null;
    if (input.tags != null) {
      const checked = cleanTags(input.tags);
      if (!checked.ok) return checked;
      tags = checked.value;
    }
    if (watchlist(ctx.read).length >= MAX_ITEMS) return refuse("watchlist_full");
    const resolved = resolveTarget(ctx, input.target);
    if (resolved === undefined) return refuse("no_instrument");
    const row = watchRowFor(ctx.read, resolved.gid);
    if (row !== undefined && row.removedAt === null) return refuse("already_watched");

    const data: Record<string, unknown> = { instrument: resolved.gid, source: input.source };
    const keepNote = row !== undefined && input.keepExistingNote && Boolean(row.note);
    const setsNote = input.note != null && !keepNote;
    if (setsNote) data.note = note;
    if (tags !== null) data.tags = tags;
    const added = ctx.det("watchlist_items", [resolved.gid]);
    ctx.emit("watchlist.added", added, data);
    return ok<WatchAddResult>({
      item: row?.gid ?? added,
      instrument: resolved.gid,
      createdInstrument: resolved.created,
      restored: row !== undefined,
      previousNote: row?.note ?? null,
      note: setsNote ? note : (row?.note ?? null),
      tags: tags ?? row?.tags ?? [],
    });
  },
});

export const updateWatchlistItem = defineCommand({
  id: "investments.updateWatchlistItem",
  input: z.object({
    /** The row gid the view shows. */
    item: gid,
    note: z.string().nullable().optional(),
    tags: textList.nullable().optional(),
  }),
  /**
   * Python `update`: a live item (removed or unknown = `no_item`, checked first), then the given
   * fields (absent / null = unchanged; a blank note clears it). Nothing given writes nothing.
   */
  run(ctx, input) {
    const item = watchlistItem(ctx.read, input.item);
    if (item === undefined) return refuse("no_item");
    const patch: { note?: string | null; tags?: string[] } = {};
    if (input.note != null) {
      const checked = cleanNote(input.note);
      if (!checked.ok) return checked;
      patch.note = checked.value;
    }
    if (input.tags != null) {
      const checked = cleanTags(input.tags);
      if (!checked.ok) return checked;
      patch.tags = checked.value;
    }
    if (Object.keys(patch).length > 0) ctx.emit("watchlist.updated", item.gid, patch);
    return ok({
      item: item.gid,
      note: patch.note === undefined ? item.note : patch.note,
      tags: patch.tags ?? item.tags,
    });
  },
});

export const removeFromWatchlist = defineCommand({
  id: "investments.removeFromWatchlist",
  input: z.object({ item: gid }),
  /**
   * Python `remove`: SOFT (the row, its note and tags, the instrument's alerts, theses and research
   * all stay; adding the instrument again restores the row). Removed or unknown = `no_item`.
   */
  run(ctx, input) {
    const item = watchlistItem(ctx.read, input.item);
    if (item === undefined) return refuse("no_item");
    // PARITY(S22b): events.md 6.4 removes a merged row by one `watchlist.removed` per live member;
    // the view has no public member map for watchlist rows, so only the row gid (its anchor) is
    // removed. A row two instrument gids were watched under before their merge stays live.
    ctx.emit("watchlist.removed", item.gid, {});
    return ok({ item: item.gid });
  },
});
