import { parseDateTime, pyStrip } from "@cashu/domain";
import { investmentsCommands } from "@cashu/store";
import { enabledModuleIds } from "@cashu/store/core";
import { mcpReviewStats } from "@cashu/store/investments/queries";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import { encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";
export async function markReviewDone(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): Promise<L.LabelledTree> {
  const module = typeof args.module === "string" ? args.module : "investments";
  if (!enabledModuleIds(ctx.store.read).has(module))
    throw new ToolError(`module ${module} is not enabled for this profile`);
  const stats: Record<string, unknown> = { source: "mcp" };
  if (Array.isArray(args.agenda) && args.agenda.length > 0)
    stats.deck = {
      agenda: args.agenda.map((a: Record<string, unknown>) => ({
        card: a.card,
        title: null,
        note: pyStrip(typeof a.note === "string" ? a.note : "") || null,
      })),
    };
  if (module === "investments") Object.assign(stats, mcpReviewStats(ctx.store.read));
  const result = await ctx.store.run(investmentsCommands.markReviewDone, {
    module,
    notes: args.notes ?? null,
    stats,
    today: ctx.today,
  });
  if (!result.ok) {
    const messages: Record<string, string> = {
      notes_too_long: "notes are too long (maximum 4000 characters)",
      unknown_module: "unknown module",
      invalid_input: "invalid review arguments",
    };
    throw new ToolError(messages[result.reason] ?? "could not record review");
  }
  return {
    review_id: L.ref(encodeEntityRef("review", result.value.review)),
    module: L.category(module),
    done_at: L.date(parseDateTime(new Date(ctx.store.now()).toISOString())),
    stats: Object.fromEntries(
      Object.entries(stats)
        .filter(([, v]) => typeof v === "number" && Number.isInteger(v))
        .map(([k, v]) => [k, L.count(v as number)]),
    ),
  };
}
