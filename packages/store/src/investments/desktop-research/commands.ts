import { z } from "zod";
import { defineCommand, refuse } from "../../command.js";
import { enabledModuleIds } from "../../core/queries.js";
import { gid } from "../../events/v1/primitives.js";
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
  const enabled = (read: Parameters<typeof enabledModuleIds>[0]) =>
    enabledModuleIds(read).has("investments");
  const dismiss = dismissResearchNoteCommand((ctx, note) =>
    stageResearchPlanAfterNote(ctx, note, inputs),
  );
  const restore = restoreResearchNoteCommand((ctx, note) =>
    stageResearchPlanAfterNote(ctx, note, inputs),
  );
  return {
    markRead: defineCommand({
      id: "investments.research.ui.markRead",
      input: markResearchRead.input,
      run(ctx, input) {
        return enabled(ctx.read) ? markResearchRead.run(ctx, input) : refuse("module_disabled");
      },
    }),
    dismissNote: defineCommand({
      id: "investments.research.ui.dismissNote",
      input: dismiss.input,
      run(ctx, input) {
        return enabled(ctx.read) ? dismiss.run(ctx, input) : refuse("module_disabled");
      },
    }),
    restoreNote: defineCommand({
      id: "investments.research.ui.restoreNote",
      input: restore.input,
      run(ctx, input) {
        return enabled(ctx.read) ? restore.run(ctx, input) : refuse("module_disabled");
      },
    }),
    acceptCandidate: defineCommand({
      id: "investments.research.ui.acceptCandidate",
      input: z.object({ note: gid, lang: z.enum(["pl", "en"]).default("pl") }),
      run(ctx, input) {
        return enabled(ctx.read)
          ? acceptCandidate.run(ctx, { ...input, instrument: null })
          : refuse("module_disabled");
      },
    }),
    undoAcceptCandidate: defineCommand({
      id: "investments.research.ui.undoAcceptCandidate",
      input: undoAcceptCandidate.input,
      run(ctx, input) {
        return enabled(ctx.read) ? undoAcceptCandidate.run(ctx, input) : refuse("module_disabled");
      },
    }),
    saveTopicThesis: defineCommand({
      id: "investments.research.ui.saveTopicThesis",
      input: saveTopicThesis.input,
      run(ctx, input) {
        return enabled(ctx.read) ? saveTopicThesis.run(ctx, input) : refuse("module_disabled");
      },
    }),
    deleteTopicThesis: defineCommand({
      id: "investments.research.ui.deleteTopicThesis",
      input: deleteTopicThesis.input,
      run(ctx, input) {
        return enabled(ctx.read) ? deleteTopicThesis.run(ctx, input) : refuse("module_disabled");
      },
    }),
    setTopicMarketView: defineCommand({
      id: "investments.research.ui.setTopicMarketView",
      input: setTopicMarketView.input,
      run(ctx, input) {
        return enabled(ctx.read)
          ? setTopicMarketView.run(ctx, { ...input, by: "owner" })
          : refuse("module_disabled");
      },
    }),
  };
}
