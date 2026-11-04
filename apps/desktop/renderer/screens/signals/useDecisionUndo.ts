import { signalsOwnerCommands } from "@cashu/store/investments/signals-screen";
import { useCommand } from "@cashu/store-react";
import type { useDurableCommands } from "../useDurableCommand.js";
import type { SignalsFeedbackApi } from "./useSignalsFeedback.js";

/** Undo of the last saved decisions (the page banner) and of one journal or signal decision. */
export function useDecisionUndo(args: {
  readonly privacy: boolean;
  readonly feedback: SignalsFeedbackApi;
  readonly durable: ReturnType<typeof useDurableCommands>;
}) {
  const { privacy, feedback, durable } = args;
  const undo = useCommand(signalsOwnerCommands.undo);
  const undoIds = feedback.state.undoIds;
  /** Reverts the last saved set in order; a failure keeps the rest undoable. */
  const undoLast = () => {
    if (!undoIds.length) return;
    void feedback.exclusive("undo", async () => {
      const remaining = [...undoIds];
      for (const id of undoIds) {
        if (!feedback.isActive()) break;
        const result = await durable.run(`undo:${id}`, undo, { decision: id });
        if (!feedback.isActive()) break;
        if (result.kind !== "completed") {
          feedback.failed(result);
          break;
        }
        remaining.shift();
      }
      if (!feedback.isActive()) return;
      feedback.setUndoIds(remaining);
      if (remaining.length === 0) feedback.setNotice("saved");
    });
  };
  const undoOne = (decision: string) => {
    if (privacy) return;
    void feedback.exclusive("undo", async () => {
      const result = await durable.run(`undo:${decision}`, undo, { decision });
      if (result.kind === "completed") {
        feedback.setUndoIds((old) => old.filter((id) => id !== decision));
        feedback.setNotice("saved");
      } else feedback.failed(result);
    });
  };
  return { undoLast, undoOne };
}
