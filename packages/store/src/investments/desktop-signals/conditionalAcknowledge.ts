/** Owner fan-out conditionality; generic journal/MCP editing primitives keep their own semantics. */
import { type CommandResult, defineCommand, ok, refuse } from "../../command.js";
import { investmentsEnabled } from "../moduleGate.js";
import { decisionSignalGids, decisions } from "../queries/journal.js";
import { signalByGid } from "../queries/signals.js";
import { signalsOwnerCommands } from "./commands.js";

export function ownerSignalUndecided(read: Parameters<typeof decisions>[0], signal: string) {
  const journal = decisions(read);
  return ![
    ...decisionSignalGids(
      read,
      journal.map((row) => row.gid),
    ).values(),
  ].some((links) => links.includes(signal));
}
export const conditionalOwnerAcknowledge = defineCommand({
  ...signalsOwnerCommands.acknowledge,
  id: "investments.review.acknowledge",
  run(
    ctx,
    input,
  ): CommandResult<{
    decision: string | null;
    signals: readonly string[];
    skipped?: "closed" | "decided";
  }> {
    if (!investmentsEnabled(ctx.read)) return refuse("module_disabled");
    const signal = signalByGid(ctx.read, input.signal);
    if (!signal) return refuse("no_signal");
    if (!["active", "acknowledged"].includes(signal.status))
      return ok({ decision: null, signals: [], skipped: "closed" });
    if (!ownerSignalUndecided(ctx.read, signal.gid))
      return ok({ decision: null, signals: [], skipped: "decided" });
    return signalsOwnerCommands.acknowledge.run(ctx, input);
  },
});
