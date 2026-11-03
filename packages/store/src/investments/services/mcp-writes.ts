/** MCP mutation composition: base effects and best-effort plan checks share one append. */

import type { DateTime } from "@cashu/domain";
import { parseDateTime, pyLen, pySplit, utcIso } from "@cashu/domain";
import { asInstrumentId, type InstrumentId } from "@cashu/domain/investments";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { PLAN_VALUES } from "../../events/v1/investments.js";
import { calendarDate, gid } from "../../events/v1/primitives.js";
import { setInstrumentPlan } from "../commands/instruments.js";
import { createThesis, updateThesis } from "../commands/journal.js";
import { addToWatchlist, removeFromWatchlist } from "../commands/watchlist.js";
import { alerts, watchedInstrumentGids, watchlistItem } from "../queries/alerts.js";
import { heldSince } from "../queries/holdings.js";
import { loadInstrument, loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import type { Read } from "../queries/shared.js";
import { instrumentRoot } from "../queries/shared.js";
import { researchable } from "../research/queries.js";
import { byCreation } from "../views/stableOrder.js";
import { captureInstrumentEffect } from "./instrument-effects.js";
import { syncPlans } from "./plan-effects.js";
import type { ResearchPlanInputs } from "./research-plans.js";
import { captureThesisEffect } from "./thesis-effects.js";

/** Source alerts_view ranks status first and insertion chronology second, never domain timestamps. */
export function mcpAlertRows(read: Read, now: DateTime) {
  const rank: Record<string, number> = {
    triggered: 0,
    active: 1,
    snoozed: 2,
    muted: 3,
    expired: 4,
  };
  return byCreation(read, "alerts", alerts(read, now), true).sort(
    (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9),
  );
}

const recommendation = z.strictObject({
  instrument: gid,
  plan: z.enum(PLAN_VALUES),
  reason: z.string(),
});
export function recommendWithPlans(inputs?: ResearchPlanInputs) {
  return defineCommand({
    id: "investments.mcp.recommend",
    input: z.object({
      today: calendarDate,
      scope: z.enum(["held", "watchlist", "all"]).nullable(),
      updates: z.array(recommendation).max(250),
    }),
    run(ctx, input) {
      const held = heldSince(ctx.read, input.today);
      const watched = watchedInstrumentGids(ctx.read);
      const selected =
        input.scope === "held"
          ? new Set(held.keys())
          : input.scope === "watchlist"
            ? watched
            : new Set([...held.keys(), ...watched]);
      const expected = new Set(
        [...loadInstruments(ctx.read, selected)]
          .filter(([, i]) => researchable(i))
          .map(([id]) => id),
      );
      const referenced = vaultInstrumentGids(ctx.read);
      const seen = new Set<string>();
      const updates = [];
      // Validate everything before any base effect is emitted.
      for (const update of input.updates) {
        const instrument = instrumentRoot(ctx.read, update.instrument);
        if (!referenced.has(instrument)) return refuse("no_instrument");
        if (input.scope !== null && !expected.has(instrument)) return refuse("outside_scope");
        if (seen.has(instrument)) return refuse("duplicate_instrument");
        seen.add(instrument);
        const parsed = setInstrumentPlan.input.safeParse({
          ...update,
          instrument,
          held: held.has(instrument),
        });
        if (!parsed.success) return refuse("invalid_input");
        updates.push(parsed.data);
      }
      if (input.scope !== null) {
        const loaded = loadInstruments(ctx.read, expected);
        if ([...expected].some((id) => !seen.has(id) && loaded.get(id)?.plan == null))
          return refuse("incomplete_coverage");
      }
      // Python proves coverage before set_plan's semantic restrictions (including needs_held).
      for (const update of updates) {
        if (pyLen(pySplit(update.reason ?? "").join(" ")) > 280) return refuse("reason_too_long");
        if (["reduce", "exit_asap"].includes(update.plan ?? "") && !update.held)
          return refuse("needs_held");
      }
      const now = parseDateTime(ctx.now());
      const generatedAt = utcIso(now).replace(/\+00:00$/, "Z");
      const pending = new Map<
        InstrumentId,
        { instrument: InstrumentId; plan: string | null; planAt: typeof now | null }
      >();
      const saved = [];
      for (const update of updates) {
        let savedReason: string | null = null;
        const out = setInstrumentPlan.run(
          {
            ...ctx,
            emit(type, target, data, options) {
              if (type !== "instrumentOverride.planSet")
                throw new Error("unexpected recommendation effect");
              savedReason = typeof data.reason === "string" ? data.reason : null;
              const id = asInstrumentId(update.instrument);
              pending.set(id, { instrument: id, plan: data.plan as string | null, planAt: now });
              return ctx.emit(type, target, { ...data, stamps: { plan_at: generatedAt } }, options);
            },
          },
          update,
        );
        if (!out.ok) return out;
        saved.push({
          instrument: update.instrument,
          plan: update.plan,
          generatedAt,
          reasonSaved: savedReason !== null,
        });
      }
      // Each check reads its own actual pending plan; other instruments' plan values are irrelevant.
      for (const [id, pendingPlan] of pending) syncPlans(ctx, inputs, [id], { pendingPlan });
      return ok({ saved, expected: expected.size, updated: saved.length });
    },
  });
}

export function upsertThesisWithPlans(inputs?: ResearchPlanInputs) {
  return defineCommand({
    id: "investments.mcp.upsertThesis",
    input: z.object({
      instrument: gid,
      values: z.object({
        entryType: z.string().optional(),
        thesis: z.string().nullable().optional(),
        invalidation: z.string().nullable().optional(),
        exitPlan: z.string().nullable().optional(),
        sizePlan: z.string().nullable().optional(),
      }),
    }),
    run(ctx, input) {
      const instrument = instrumentRoot(ctx.read, input.instrument);
      if (!vaultInstrumentGids(ctx.read).has(instrument)) return refuse("no_instrument");
      const before = theses(ctx.read, instrument)[0];
      const effect = captureThesisEffect(ctx, before);
      const child = effect.context;
      const out =
        before === undefined
          ? createThesis.run(child, createThesis.input.parse({ instrument, ...input.values }))
          : updateThesis.run(
              child,
              updateThesis.input.parse({ id: before.gid, values: input.values }),
            );
      if (!out.ok) return out;
      const row = effect.row() ?? before;
      if (row === undefined) throw new Error("thesis effect was not prepared");
      syncPlans(ctx, inputs, [instrument], { pendingTheses: new Map([[instrument, row]]) });
      return ok({
        thesis: row.gid,
        instrument,
        created: before === undefined,
        entryType: row.entryType,
        row,
      });
    },
  });
}

export function addStoredWatchWithPlans(inputs?: ResearchPlanInputs) {
  return defineCommand({
    id: "investments.mcp.addStoredWatch",
    input: z.object({ instrument: gid, note: z.string().nullable().optional() }),
    run(ctx, input) {
      const instrument = instrumentRoot(ctx.read, input.instrument);
      if (!vaultInstrumentGids(ctx.read).has(instrument)) return refuse("no_instrument");
      const out = addToWatchlist.run(
        ctx,
        addToWatchlist.input.parse({ target: { instrument }, note: input.note, source: "agent" }),
      );
      if (!out.ok) return out;
      syncPlans(ctx, inputs, [instrument], {
        pendingWatched: new Set([...watchedInstrumentGids(ctx.read), instrument]),
      });
      return out;
    },
  });
}
/** Full native command, with prospective facts captured from its actual winning effects. */
export function addWatchWithPlans(inputs?: ResearchPlanInputs) {
  return defineCommand({
    id: "investments.mcp.addWatch",
    input: addToWatchlist.input,
    run(ctx, input) {
      const effect = captureInstrumentEffect(ctx);
      const out = addToWatchlist.run(effect.context, input);
      if (!out.ok) return out;
      const instrument = out.value.instrument;
      const created = effect.row(instrument);
      const prospectiveInstrument = created ?? loadInstrument(ctx.read, instrument);
      if (!prospectiveInstrument || out.value.createdInstrument !== (created !== undefined))
        throw new Error("watch prospective instrument mismatch");
      syncPlans(ctx, inputs, [instrument], {
        pendingWatched: new Set([...watchedInstrumentGids(ctx.read), instrument]),
        ...(created === undefined ? {} : { pendingInstruments: new Map([[instrument, created]]) }),
      });
      return ok({ ...out.value, prospectiveInstrument });
    },
  });
}
export function removeWatchWithPlans(inputs?: ResearchPlanInputs) {
  return defineCommand({
    id: "investments.mcp.removeWatch",
    input: removeFromWatchlist.input,
    run(ctx, input) {
      const item = watchlistItem(ctx.read, input.item);
      if (item === undefined) return refuse("no_item");
      const out = removeFromWatchlist.run(ctx, input);
      if (!out.ok) return out;
      const watched = watchedInstrumentGids(ctx.read);
      watched.delete(item.instrument);
      syncPlans(ctx, inputs, [item.instrument], { pendingWatched: watched });
      return out;
    },
  });
}
