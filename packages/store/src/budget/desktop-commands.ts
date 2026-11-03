// S55c API result adapter: Python reports eligible rows, even for an unchanged merchant rule.
import { merchantKey } from "@cashu/domain/budget";
import { defineCommand, ok } from "../command.js";
import { setMerchantCategory } from "./commands.js";
import { budgetBook } from "./read-models.js";

export const setDesktopMerchantCategory = defineCommand({
  id: "budget.setDesktopMerchantCategory",
  input: setMerchantCategory.input,
  run(ctx, input) {
    const rows = budgetBook(ctx.read).transactions;
    const updated = rows.filter(
      (row) =>
        !row.isInternalTransfer &&
        !["manual_txn", "cash_leg", "transfer"].includes(row.categorySource ?? "") &&
        !["transfer", "cash_withdrawal"].includes(row.category ?? "") &&
        merchantKey(row.counterpartyName, row.reference, row.description) === input.merchantKey,
    ).length;
    const result = setMerchantCategory.run(ctx, input);
    return result.ok ? ok({ updated }) : result;
  },
});
