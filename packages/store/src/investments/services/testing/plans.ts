// Test support: the old model recommendation write (Python `api.py` `PUT instruments/{id}/plan`; the
// shipped MCP path is mcp-writes.ts `recommendWithPlans`): the instrument must be one the vault
// references, `held` comes from the vault's transactions on the caller's day, then
// `setInstrumentPlan` (S22d) validates and writes, then the plan checks stage derived signals.

import { type DateTime, parseDateTime, utcIso } from "@cashu/domain";
import { asInstrumentId, type ValuedPortfolio } from "@cashu/domain/investments";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import { z } from "zod";
import {
  type CommandContext,
  type CommandEnv,
  type CommandOutcome,
  defineCommand,
  type EventWriter,
  refuse,
  runCommand,
} from "../../../command.js";
import { calendarDate, gid } from "../../../events/v1/primitives.js";
import type { Store } from "../../../materialize.js";
import { stageDerivedSignals } from "../../commands/derivedSignals.js";
import { setInstrumentPlan } from "../../commands/instruments.js";
import { applyPlanChecks } from "../../commands/planSignals.js";
import { heldSince } from "../../queries/holdings.js";
import { vaultInstrumentGids } from "../../queries/instruments.js";
import { type PendingPlan, planFacts } from "../../queries/planFacts.js";
import { instrumentRoot } from "../../queries/shared.js";

export interface PlanWrite {
  readonly instrument: string;
  /** A `PLAN_VALUES` value, or null to clear (an absent key is invalid input, never a clear). */
  readonly plan: string | null;
  readonly reason?: string | null;
  /** The caller's local calendar day (`YYYY-MM-DD`): what "held" means. */
  readonly today: string;
}

export function writePlan(
  deps: {
    readonly store: Store;
    readonly writer: EventWriter;
    readonly env: CommandEnv;
    /** Local cached valuation only. Scheduling/cache construction and other owner callers: S22c. */
    readonly immediate?: {
      readonly buildValued: (read: CommandContext["read"], now: DateTime) => ValuedPortfolio;
      readonly config: StrategyConfig | null;
      readonly lang: "pl" | "en";
    };
  },
  input: PlanWrite,
): CommandOutcome<{ instrument: string }> {
  const command = defineCommand({
    id: "investments.writePlan",
    input: z.object({
      instrument: gid,
      plan: z.unknown(),
      reason: z.string().nullable().optional(),
      today: calendarDate,
    }),
    run(ctx, raw) {
      const root = instrumentRoot(ctx.read, raw.instrument);
      if (!vaultInstrumentGids(ctx.read).has(root)) return refuse("no_instrument");
      const held = heldSince(ctx.read, raw.today).has(root);
      const parsed = setInstrumentPlan.input.safeParse({
        instrument: root,
        plan: raw.plan,
        reason: raw.reason ?? null,
        held,
      });
      if (!parsed.success) return refuse("invalid_input");
      const now = parseDateTime(ctx.now());
      let pending: PendingPlan | undefined;
      const base = setInstrumentPlan.run(
        {
          ...ctx,
          emit(type, target, data, options) {
            if (type !== "instrumentOverride.planSet")
              throw new Error("unexpected plan write effect");
            pending = {
              instrument: asInstrumentId(root),
              plan: parsed.data.plan,
              planAt: parsed.data.plan === null ? null : now,
            };
            return ctx.emit(
              type,
              target,
              {
                ...data,
                stamps: {
                  plan_at: parsed.data.plan === null ? null : utcIso(now).replace(/\+00:00$/, "Z"),
                },
              },
              options,
            );
          },
        },
        parsed.data,
      );
      if (!base.ok || deps.immediate === undefined || !ctx.lease.isHolder()) return base;
      const immediate = deps.immediate;
      const staged = stageDerivedSignals(ctx, (child) => {
        const valued = immediate.buildValued(child.read, now);
        if (valued.snapshot.profileId !== child.vault) return refuse("invalid_identity");
        const facts = planFacts(child.read, {
          valued,
          now,
          only: asInstrumentId(root),
          ...(pending === undefined ? {} : { pendingPlan: pending }),
        });
        return applyPlanChecks(child, {
          facts,
          now,
          run: null,
          config: immediate.config,
          only: asInstrumentId(root),
          lang: immediate.lang,
        });
      });
      // Derivation failures discard only the staged effects; parent emission failures propagate.
      if (staged.ok) staged.flush();
      return base;
    },
  });
  return runCommand(deps.store, deps.writer, command, input, deps.env);
}
