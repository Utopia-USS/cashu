// S55c API result adapter: expose the command's exact effective pair-change count.
import { defineCommand, ok } from "../command.js";
import { setMerchantCategory } from "./commands.js";

export const setDesktopMerchantCategory = defineCommand({
  id: "budget.setDesktopMerchantCategory",
  input: setMerchantCategory.input,
  run(ctx, input) {
    const result = setMerchantCategory.run(ctx, input);
    return result.ok ? ok({ updated: result.value.updated }) : result;
  },
});
