/** Closed owner command list; evaluation authority is neither required nor acquired here. */
import type { Command } from "../../command.js";
import { deleteAlert, restoreAlert, updateAlertWithBuckets } from "../commands/alertWrites.js";
import { acknowledgeSignal, decidePosition, decideSignal } from "../commands/decisions.js";
import { undoDecision } from "../commands/journal.js";
import type { CurrentStrategySource } from "../desktop/sources.js";
import { moduleGated } from "../moduleGate.js";

function ownerCommand<I, R, In>(command: Command<I, R, In>): Command<I, R, In> {
  return moduleGated(command, command.id.replace("investments.", "investments.signals."));
}
export const signalsOwnerCommands = {
  decide: ownerCommand(decideSignal),
  positionDecision: ownerCommand(decidePosition),
  acknowledge: ownerCommand(acknowledgeSignal),
  undo: ownerCommand(undoDecision),
  deleteAlert: ownerCommand(deleteAlert),
  restoreAlert: ownerCommand(restoreAlert),
};

/** The current file image supplies generic bucket authority at command execution time. */
export function signalsAlertCommands(strategy?: CurrentStrategySource) {
  const currentBuckets = (read: Parameters<CurrentStrategySource["current"]>[0]) => {
    const image = strategy?.current(read);
    if (image === undefined || image.status !== "current") return null;
    const buckets = image.state.config?.allocation.buckets ?? [];
    return new Set(buckets.map((bucket) => bucket.id));
  };
  return {
    update: ownerCommand(updateAlertWithBuckets(currentBuckets)),
  };
}
