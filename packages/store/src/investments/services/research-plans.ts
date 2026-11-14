/** Python plans.sync_after_note: best-effort derived checks in the note's one atomic append. */
import { type DateTime, parseDateTime } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { asInstrumentId, type ValuedPortfolio } from "@cashu/domain/investments";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { stageDerivedSignals } from "../commands/derivedSignals.js";
import { applyPlanChecks } from "../commands/planSignals.js";
import { planFacts } from "../queries/planFacts.js";
import { researchNoteCommand } from "../research/commands.js";
import type { ResearchNote } from "../research/rows.js";

export interface ResearchPlanInputs {
  readonly vault: string;
  readonly config: StrategyConfig | null;
  readonly lang: UiLang;
  /** Genuine coherent local inputs only; no file/network work or dummy cache inside this callback. */
  buildValued(read: CommandContext["read"], now: DateTime): ValuedPortfolio;
  /** Notes are research-device writes, but derived plan signals require real fetch authority. */
  isHolder(vault: string): boolean;
}

/** Stage only genuinely held, coherent derived checks; the base research write survives refusal. */
export function stageResearchPlanAfterNote(
  ctx: CommandContext,
  note: ResearchNote,
  inputs?: ResearchPlanInputs,
) {
  if (note.instrument === null || note.kind === "candidate" || inputs === undefined) return;
  const holder = () => {
    try {
      return inputs.vault === ctx.vault && inputs.isHolder(ctx.vault);
    } catch {
      return false;
    }
  };
  if (!holder()) return;
  try {
    const now = parseDateTime(ctx.now());
    const derived = stageDerivedSignals({ ...ctx, lease: { isHolder: holder } }, (staged) => {
      const valued = inputs.buildValued(staged.read, now);
      if (valued.snapshot.profileId !== ctx.vault || !holder()) return refuse("invalid_identity");
      const only = asInstrumentId(note.instrument as string);
      const facts = planFacts(staged.read, {
        valued,
        now,
        only,
        pendingResearchNotes: new Map([[note.gid, note]]),
      });
      return applyPlanChecks(staged, {
        facts,
        now,
        only,
        run: null,
        config: inputs.config,
        lang: inputs.lang,
      });
    });
    if (derived.ok && holder()) derived.flush();
  } catch {
    // Derived checks are best effort; the independently valid base research write survives.
  }
}

/** Returns the actual prospective row for the labelled MCP response without a pre-privacy append. */
export function addResearchNoteWithPlans(inputs?: ResearchPlanInputs) {
  const source = researchNoteCommand();
  return defineCommand({
    id: "investments.research.addNoteWithPlans",
    input: source.input,
    run(ctx, input) {
      let row: ResearchNote | undefined;
      const base = researchNoteCommand((child, note) => {
        row = note;
        stageResearchPlanAfterNote(child, note, inputs);
      }).run(ctx, input);
      if (!base.ok) return base;
      if (row === undefined) throw new Error("research note was not prepared");
      return ok({ ...base.value, row });
    },
  });
}
