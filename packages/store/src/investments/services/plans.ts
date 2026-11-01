// The model recommendation write (Python `api.py` `PUT instruments/{id}/plan` and the MCP
// `set_recommendation` path): the instrument must be one the vault references, `held` comes from the
// vault's transactions on the caller's day, then `setInstrumentPlan` (S22d) validates and writes.
// Plan-check evaluators and immediate recomputation after a write (`plans.sync_instrument`) remain
// S16 / S22c. The generic signal reconciler does not evaluate those checks or schedule a daily pass.
import {
  type CommandEnv,
  type CommandOutcome,
  type EventWriter,
  runCommand,
} from "../../command.js";
import type { Store } from "../../materialize.js";
import { setInstrumentPlan } from "../commands/instruments.js";
import { heldSince } from "../queries/holdings.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentRoot } from "../queries/shared.js";

export interface PlanWrite {
  readonly instrument: string;
  /** A `PLAN_VALUES` value, or null to clear (an absent key is invalid input, never a clear). */
  readonly plan: string | null;
  readonly reason?: string | null;
  /** The caller's local calendar day (`YYYY-MM-DD`): what "held" means. */
  readonly today: string;
}

export function writePlan(
  deps: { readonly store: Store; readonly writer: EventWriter; readonly env: CommandEnv },
  input: PlanWrite,
): CommandOutcome<{ instrument: string }> {
  const read = deps.store.read.bind(deps.store);
  const root = instrumentRoot(read, input.instrument);
  if (!vaultInstrumentGids(read).has(root)) return { ok: false, reason: "no_instrument" };
  const held = heldSince(read, input.today).has(root);
  return runCommand(
    deps.store,
    deps.writer,
    setInstrumentPlan,
    { instrument: root, plan: input.plan, reason: input.reason ?? null, held },
    deps.env,
  );
}
