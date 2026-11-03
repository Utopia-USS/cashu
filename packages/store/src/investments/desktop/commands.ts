/** Owner API semantics; one buffered command preserves classification/thesis atomicity. */
import { z } from "zod";
import { type Command, defineCommand, ok, refuse } from "../../command.js";
import { enabledModuleIds } from "../../core/queries.js";
import {
  ASSET_CLASSES,
  INSTRUMENT_STATUSES,
  VALUATION_MODES,
} from "../../events/v1/investments.js";
import { gid } from "../../events/v1/primitives.js";
import { addBrokerageAccount } from "../commands/accounts.js";
import { classifyInstrument, setInstrumentSegment } from "../commands/instruments.js";
import { createThesis, updateThesis } from "../commands/journal.js";
import { addManualTransaction } from "../commands/manual.js";
import { updateWatchlistItem } from "../commands/watchlist.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { theses, thesisByGid } from "../queries/journal.js";
import { instrumentRoot } from "../queries/shared.js";
import { syncPlans } from "../services/plan-effects.js";
import type { ResearchPlanInputs } from "../services/research-plans.js";
import { captureThesisEffect } from "../services/thesis-effects.js";

function moduleCommand<I, R, In>(command: Command<I, R, In>): Command<I, R, In> {
  return {
    ...command,
    run(ctx, input) {
      return enabledModuleIds(ctx.read).has("investments")
        ? command.run(ctx, input)
        : refuse("module_disabled");
    },
  };
}
export const createUiBrokerageAccount = moduleCommand(addBrokerageAccount);
export const addUiManualTransaction = moduleCommand(addManualTransaction);
export const updateUiWatchNote = moduleCommand(updateWatchlistItem);

const classifyPatch = z.strictObject({
  assetClass: z.enum(ASSET_CLASSES).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  valuationMode: z.enum(VALUATION_MODES).nullable().optional(),
  region: z.string().nullable().optional(),
  sector: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  status: z.enum(INSTRUMENT_STATUSES).nullable().optional(),
  aliases: z.array(z.strictObject({ namespace: z.string(), value: z.string() })).optional(),
  segment: z.string().nullable().optional(),
});
export const classifyUiInstrument = moduleCommand(
  defineCommand({
    id: "investments.desktop.classify",
    input: z.strictObject({ instrument: gid, patch: classifyPatch }),
    run(ctx, input) {
      const instrument = instrumentRoot(ctx.read, input.instrument);
      if (!vaultInstrumentGids(ctx.read).has(instrument)) return refuse("no_instrument");
      const patch = input.patch;
      if ("segment" in patch) {
        const result = setInstrumentSegment.run(ctx, {
          instrument,
          segment: patch.segment ?? null,
          by: "owner",
        });
        if (!result.ok) return result;
      }
      if (Object.keys(patch).some((key) => key !== "segment") || Object.keys(patch).length === 0) {
        const checked = classifyInstrument.input.safeParse({
          instrument,
          ...Object.fromEntries(
            Object.entries(patch).filter(
              ([key, value]) => key !== "segment" && key !== "aliases" && value != null,
            ),
          ),
          aliases: (patch.aliases ?? []).map((alias) => ({
            ...alias,
            namespace: alias.namespace.trim().toLowerCase(),
          })),
          reviewed: true,
        });
        if (!checked.success) return refuse("invalid_input");
        const result = classifyInstrument.run(ctx, checked.data);
        if (!result.ok) return result;
      }
      return ok({ instrument });
    },
  }),
);

export function uiThesisCommands(inputs?: ResearchPlanInputs) {
  return {
    create: moduleCommand(
      defineCommand({
        id: "investments.desktop.createThesis",
        input: createThesis.input,
        run(ctx, input) {
          const instrument = instrumentRoot(ctx.read, input.instrument);
          if (!vaultInstrumentGids(ctx.read).has(instrument)) return refuse("no_instrument");
          const effect = captureThesisEffect(ctx);
          const result = createThesis.run(effect.context, { ...input, instrument });
          if (!result.ok) return result;
          const row = effect.row();
          if (row === undefined) throw new Error("missing thesis effect");
          const latest = theses(ctx.read, instrument)[0];
          // runCommand observes the log HWM, so this new creation wins native creation-rank ties.
          const pending =
            latest === undefined || row.createdAt >= latest.createdAt
              ? { pendingTheses: new Map([[instrument, row]]) }
              : {};
          syncPlans(ctx, inputs, [instrument], pending);
          return ok({ ...result.value, row });
        },
      }),
    ),
    update: moduleCommand(
      defineCommand({
        id: "investments.desktop.updateThesis",
        input: updateThesis.input,
        run(ctx, input) {
          const before = thesisByGid(ctx.read, input.id);
          if (before === undefined) return refuse("no_thesis");
          const effect = captureThesisEffect(ctx, before);
          const result = updateThesis.run(effect.context, input);
          if (!result.ok) return result;
          const row = effect.row() ?? before;
          const latest = theses(ctx.read, row.instrument)[0];
          syncPlans(
            ctx,
            inputs,
            [row.instrument],
            latest?.gid === row.gid
              ? {
                  pendingTheses: new Map([[row.instrument, row]]),
                }
              : {},
          );
          return ok({ ...result.value, row });
        },
      }),
    ),
  };
}
