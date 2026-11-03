/** Closed owner command list; evaluation authority is neither required nor acquired here. */
import { type Command, refuse } from "../../command.js";
import { enabledModuleIds } from "../../core/queries.js";
import { deleteAlert, restoreAlert } from "../commands/alertWrites.js";
import { acknowledgeSignal, decidePosition, decideSignal } from "../commands/decisions.js";
import { undoDecision } from "../commands/journal.js";

function ownerCommand<I, R, In>(command: Command<I, R, In>): Command<I, R, In> {
  return {
    ...command,
    id: command.id.replace("investments.", "investments.signals."),
    run(ctx, input) {
      return enabledModuleIds(ctx.read).has("investments")
        ? command.run(ctx, input)
        : refuse("module_disabled");
    },
  };
}
export const signalsOwnerCommands = {
  decide: ownerCommand(decideSignal),
  positionDecision: ownerCommand(decidePosition),
  acknowledge: ownerCommand(acknowledgeSignal),
  undo: ownerCommand(undoDecision),
  deleteAlert: ownerCommand(deleteAlert),
  restoreAlert: ownerCommand(restoreAlert),
};
