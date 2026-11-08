import { z } from "zod";
import { defineCommand, refuse } from "../../command.js";
import { gid } from "../../events/v1/primitives.js";
import { investmentsEnabled, moduleGated } from "../moduleGate.js";
import { acceptCandidate, undoAcceptCandidate } from "../research/candidates.js";
import {
  dismissResearchNoteCommand,
  markResearchRead,
  restoreResearchNoteCommand,
} from "../research/commands.js";
import { deleteTopicThesis, saveTopicThesis, setTopicMarketView } from "../research/topics.js";
import { type ResearchPlanInputs, stageResearchPlanAfterNote } from "../services/research-plans.js";

/** The renderer can invoke owner actions only; agent run and note creation stay outside this surface. */
export function researchScreenCommands(inputs?: ResearchPlanInputs) {
  const dismiss = dismissResearchNoteCommand((ctx, note) =>
    stageResearchPlanAfterNote(ctx, note, inputs),
  );
  const restore = restoreResearchNoteCommand((ctx, note) =>
    stageResearchPlanAfterNote(ctx, note, inputs),
  );
  return {
    markRead: moduleGated(markResearchRead, "investments.research.ui.markRead"),
    dismissNote: moduleGated(dismiss, "investments.research.ui.dismissNote"),
    restoreNote: moduleGated(restore, "investments.research.ui.restoreNote"),
    acceptCandidate: defineCommand({
      id: "investments.research.ui.acceptCandidate",
      input: z.object({ note: gid, lang: z.enum(["pl", "en"]).default("pl") }),
      run(ctx, input) {
        return investmentsEnabled(ctx.read)
          ? acceptCandidate.run(ctx, { ...input, instrument: null })
          : refuse("module_disabled");
      },
    }),
    undoAcceptCandidate: moduleGated(
      undoAcceptCandidate,
      "investments.research.ui.undoAcceptCandidate",
    ),
    saveTopicThesis: moduleGated(saveTopicThesis, "investments.research.ui.saveTopicThesis"),
    deleteTopicThesis: moduleGated(deleteTopicThesis, "investments.research.ui.deleteTopicThesis"),
    setTopicMarketView: defineCommand({
      id: "investments.research.ui.setTopicMarketView",
      input: setTopicMarketView.input,
      run(ctx, input) {
        return investmentsEnabled(ctx.read)
          ? setTopicMarketView.run(ctx, { ...input, by: "owner" })
          : refuse("module_disabled");
      },
    }),
  };
}
