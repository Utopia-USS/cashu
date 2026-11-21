// Test support: a depreciation curve on any visible account, without the asset checks of
// `updateAssetDetails` (the overview tests put one on a manual position).
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { decimalInput, visibleAccount } from "../../core/commands.js";
import { calendarDate, gid } from "../../events/v1/primitives.js";

export const setDepreciation = defineCommand({
  id: "assets.setDepreciation",
  input: z.object({
    account: gid,
    purchasePrice: decimalInput,
    purchaseDate: calendarDate,
    annualRate: decimalInput,
    floor: decimalInput.nullable().optional(),
  }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined) return refuse("no_account");
    ctx.emit("depreciation.set", ctx.det("depreciations", [a.gid]), {
      account: a.gid,
      purchasePrice: input.purchasePrice,
      purchaseDate: input.purchaseDate,
      annualRate: input.annualRate,
      floor: input.floor ?? null,
    });
    return ok(null);
  },
});
