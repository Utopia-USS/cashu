/** Neutral best-effort plan composition shared by owner UI and MCP. */
import { parseDateTime } from "@cashu/domain";
import { asInstrumentId } from "@cashu/domain/investments";
import { type CommandContext, ok, refuse } from "../../command.js";
import { stageDerivedSignals } from "../commands/derivedSignals.js";
import { applyPlanChecks } from "../commands/planSignals.js";
import { type PlanFactsInput, planFacts } from "../queries/planFacts.js";
import type { ResearchPlanInputs } from "./research-plans.js";

/** Every derived draft is discarded on failure or loss of the genuine injected authority. */
export function syncPlans(
  ctx: CommandContext,
  inputs: ResearchPlanInputs | undefined,
  instruments: Iterable<string>,
  pending: Pick<
    PlanFactsInput,
    "pendingPlan" | "pendingTheses" | "pendingWatched" | "pendingInstruments"
  > = {},
) {
  const holder = () => {
    try {
      return inputs?.vault === ctx.vault && inputs.isHolder(ctx.vault) === true;
    } catch {
      return false;
    }
  };
  if (inputs === undefined || !holder()) return;
  const now = parseDateTime(ctx.now());
  const staged = stageDerivedSignals({ ...ctx, lease: { isHolder: holder } }, (child) => {
    const valued = inputs.buildValued(child.read, now);
    if (valued.snapshot.profileId !== ctx.vault || !holder()) return refuse("invalid_identity");
    for (const instrument of new Set(instruments)) {
      const only = asInstrumentId(instrument);
      const pendingCanonical = new Set(
        [...(pending.pendingInstruments?.keys() ?? [])].map(asInstrumentId),
      );
      const facts = planFacts(child.read, { valued, now, only, ...pending });
      const out = applyPlanChecks(child, {
        facts,
        now,
        only,
        pendingCanonical,
        run: null,
        config: inputs.config,
        lang: inputs.lang,
      });
      if (!out.ok) return out;
    }
    return ok({});
  });
  if (staged.ok && holder()) staged.flush();
}
