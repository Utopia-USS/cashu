// S55c API result adapters: expose the command's exact effective counts to the desktop.
import { z } from "zod";
import { defineCommand, ok } from "../command.js";
import { matchTransfersCommand, setMerchantCategory } from "./commands.js";

export const setDesktopMerchantCategory = defineCommand({
  id: "budget.setDesktopMerchantCategory",
  input: setMerchantCategory.input,
  run(ctx, input) {
    const result = setMerchantCategory.run(ctx, input);
    return result.ok ? ok({ updated: result.value.updated }) : result;
  },
});

/**
 * The first steps' `Dopasuj` (Python POST /budget/match-transfers {max_days?} -> {pairs}): pair the
 * still unpaired internal transfers between the vault's own accounts (counterparty IBAN only, rule 5)
 * without releasing earlier pairs; `pairs` = the new pairs. Categories follow from the derivers.
 */
export const matchDesktopTransfers = defineCommand({
  id: "budget.matchDesktopTransfers",
  input: z.strictObject({ maxDays: z.int().min(0).max(31).default(3) }),
  run(ctx, input) {
    const result = matchTransfersCommand.run(ctx, { reset: false, maxDays: input.maxDays });
    return result.ok ? ok({ pairs: result.value.matched }) : result;
  },
});
