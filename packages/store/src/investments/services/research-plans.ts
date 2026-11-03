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

/** Returns the actual prospective row for the labelled MCP response without a pre-privacy append. */
export function addResearchNoteWithPlans(inputs?: ResearchPlanInputs) {
  const source = researchNoteCommand();
  const authority = inputs?.isHolder.bind(inputs);
  const buildValued = inputs?.buildValued.bind(inputs);
  const vault = inputs?.vault;
  const config = inputs?.config ?? null;
  const lang = inputs?.lang ?? "pl";
  return defineCommand({
    id: "investments.research.addNoteWithPlans",
    input: source.input,
    run(ctx, input) {
      let row: ResearchNote | undefined;
      const base = researchNoteCommand((child, note) => {
        row = note;
        const instrument = note.instrument;
        if (instrument === null || note.kind === "candidate" || buildValued === undefined) return;
        const holder = () => {
          try {
            return vault === child.vault && authority?.(child.vault) === true;
          } catch {
            return false;
          }
        };
        if (!holder()) return;
        const now = parseDateTime(child.now());
        const derived = stageDerivedSignals({ ...child, lease: { isHolder: holder } }, (staged) => {
          const valued = buildValued(staged.read, now);
          if (valued.snapshot.profileId !== child.vault || !holder())
            return refuse("invalid_identity");
          const only = asInstrumentId(instrument);
          const facts = planFacts(staged.read, {
            valued,
            now,
            only,
            pendingResearchNotes: new Map([[note.gid, note]]),
          });
          return applyPlanChecks(staged, { facts, now, only, run: null, config, lang });
        });
        // Python compute failure / savepoint failure preserves the successful note and research signal.
        if (derived.ok && holder()) derived.flush();
      }).run(ctx, input);
      if (!base.ok) return base;
      if (row === undefined) throw new Error("research note was not prepared");
      return ok({ ...base.value, row });
    },
  });
}
