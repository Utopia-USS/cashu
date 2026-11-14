// Review records (Python `core/reviews.py` `mark_done` / `undo`, write side): "I looked at module X",
// from the app or over MCP. `review.done` is APPEND, `review.undone` a TOMB; the undo window is
// checked here at emit time against the view (events.md 6.3).
import {
  type DateTime,
  fromIsoFormat,
  type IsoDate,
  PyValueError,
  parseDateTime,
  pyLen,
  pyStrip,
  utcIso,
} from "@cashu/domain";
import { builtinRegistry } from "@cashu/domain/core";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { calendarDate, gid, jsonObject } from "../../events/v1/primitives.js";
import { reviewByGid } from "../queries/reviews.js";
import { storedTime } from "../queries/shared.js";

/** Python `MAX_NOTES` (characters). */
export const MAX_REVIEW_NOTES = 4000;
/** Python `UNDO_WINDOW`: how long after saving a review it can still be undone. */
export const REVIEW_UNDO_WINDOW_MS = 15 * 60 * 1000;
/** Python `RECORDED_AT`: stats key of a backdated review, when it was saved (the undo window counts from it). */
export const RECORDED_AT = "recorded_at";

/** Microseconds since the epoch of a Python datetime (naive = UTC, the SQLite convention). */
function epochMicros(t: DateTime): number {
  const [y, m, d] = t.date.split("-").map(Number) as [number, number, number];
  const seconds = Date.UTC(y, m - 1, d, t.hour, t.minute, t.second) / 1000 - (t.offsetSeconds ?? 0);
  return seconds * 1_000_000 + t.microsecond;
}

export const markReviewDone = defineCommand({
  id: "investments.markReviewDone",
  input: z.object({
    module: z.string(),
    notes: z.string().nullable().default(null),
    stats: jsonObject.default({}),
    /** A past calendar day (`YYYY-MM-DD`, e.g. an imported check-in); null / today = now. */
    doneAt: z.string().nullable().default(null),
    /** The caller's local calendar day (Python `date.today()`); default the UTC day of the clock. */
    today: calendarDate.optional(),
  }),
  /**
   * Python `mark_done`, checks in its order: notes (trimmed, at most MAX_REVIEW_NOTES), the day
   * (a date, not in the future: a past day is stored at 12:00 UTC and its stats get `recorded_at`),
   * then the module (a registered one).
   */
  run(ctx, input) {
    const notes = pyStrip(input.notes ?? "") || null;
    if (notes !== null && pyLen(notes) > MAX_REVIEW_NOTES) return refuse("notes_too_long");
    const now = ctx.now();
    let doneOn: IsoDate | null = null;
    if (input.doneAt !== null) {
      try {
        doneOn = fromIsoFormat(pyStrip(input.doneAt));
      } catch (error) {
        if (!(error instanceof PyValueError)) throw error;
        return refuse("invalid_done_at");
      }
      const today = input.today ?? ctx.today();
      if (doneOn > today) return refuse("done_at_in_future");
      if (doneOn === today) doneOn = null;
    }
    const stats: Record<string, unknown> = { ...input.stats };
    if (doneOn !== null) stats[RECORDED_AT] = utcIso(now);
    const module = pyStrip(input.module);
    if (!builtinRegistry().modules.has(module)) return refuse("unknown_module");
    const review = ctx.newGid();
    ctx.emit("review.done", review, {
      module,
      ...(doneOn === null ? {} : { doneAt: `${doneOn}T12:00:00.000Z` }),
      notes,
      stats,
    });
    return ok({ review });
  },
});

export const undoReview = defineCommand({
  id: "investments.undoReview",
  input: z.object({ review: gid }),
  /**
   * Python `undo`: only within REVIEW_UNDO_WINDOW_MS of saving it (`done_at`, or `recorded_at` of a
   * backdated review when it parses).
   */
  run(ctx, input) {
    const row = reviewByGid(ctx.read, input.review);
    if (row === undefined) return refuse("no_review");
    let saved = epochMicros(storedTime(row.doneAt));
    const recorded = row.stats[RECORDED_AT];
    if (typeof recorded === "string") {
      try {
        saved = epochMicros(parseDateTime(recorded));
      } catch (error) {
        if (!(error instanceof PyValueError)) throw error;
      }
    }
    if (Date.parse(ctx.now()) * 1000 - saved > REVIEW_UNDO_WINDOW_MS * 1000) {
      return refuse("undo_expired");
    }
    ctx.emit("review.undone", row.gid, {});
    return ok({ review: row.gid });
  },
});
