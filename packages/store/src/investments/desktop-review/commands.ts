/** App review writes recheck authoritative facts in the same command snapshot. */
import { pyLen } from "@cashu/domain";
import { z } from "zod";
import { defineCommand, refuse } from "../../command.js";
import { enabledModuleIds } from "../../core/queries.js";
import { markReviewDone, undoReview } from "../commands/reviews.js";
import { signalsOwnerCommands } from "../desktop-signals/commands.js";
import { ownerSignalUndecided } from "../desktop-signals/conditionalAcknowledge.js";
import { mcpReviewStats } from "../queries/mcp.js";
import { reviewByGid } from "../queries/reviews.js";
import { signalByGid } from "../queries/signals.js";

export const reviewPositionDecision = defineCommand({
  ...signalsOwnerCommands.positionDecision,
  id: "investments.review.positionDecision",
  run(ctx, input) {
    if (!enabledModuleIds(ctx.read).has("investments")) return refuse("module_disabled");
    const signals = input.signals.filter((gid) => {
      const signal = signalByGid(ctx.read, gid);
      return (
        signal !== undefined &&
        ["active", "acknowledged"].includes(signal.status) &&
        ownerSignalUndecided(ctx.read, signal.gid)
      );
    });
    if (signals.length === 0) return refuse("no_open_signal");
    return signalsOwnerCommands.positionDecision.run(ctx, { ...input, signals });
  },
});

const card = z.enum(["world", "sectors", "positions", "events", "ideas", "calendar", "decide"]);
export const reviewNotesSchema = z.string().refine((value) => pyLen(value.trim()) <= 4000);
export const reviewSessionSchema = z.object({
  cards: z.array(z.object({ id: card, verdict: z.enum(["keep", "flag"]) })).max(7),
  agenda: z.array(z.object({ card, note: reviewNotesSchema.nullable() })).max(7),
  decisions: z
    .array(z.object({ subject: z.string().max(200), choice: z.string().max(80) }))
    .max(1000),
  skipped: z.array(z.object({ id: card, reason: z.string().max(200) })).max(7),
  minutes: z.number().int().min(0).max(525600),
});
export const saveReview = defineCommand({
  id: "investments.review.save",
  input: z.object({ notes: reviewNotesSchema.nullable(), session: reviewSessionSchema }),
  run(ctx, input) {
    if (!enabledModuleIds(ctx.read).has("investments")) return refuse("module_disabled");
    const result = markReviewDone.run(ctx, {
      module: "investments",
      notes: input.notes,
      doneAt: null,
      stats: { source: "app", ...mcpReviewStats(ctx.read), session: input.session },
    });
    return result.ok
      ? { ok: true as const, value: { ...result.value, savedAt: ctx.now() } }
      : result;
  },
});
export const undoSavedReview = defineCommand({
  ...undoReview,
  id: "investments.review.undo",
  run(ctx, input) {
    if (!enabledModuleIds(ctx.read).has("investments")) return refuse("module_disabled");
    if (reviewByGid(ctx.read, input.review)?.module !== "investments") return refuse("no_review");
    return undoReview.run(ctx, input);
  },
});
