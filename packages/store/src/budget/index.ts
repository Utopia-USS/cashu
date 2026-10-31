// The budget store module (S23 part: transactions as far as the reference fold goes, merchant
// category rules). S24 adds import batches, cash expenses and the derived columns.
import type { StoreModule } from "../registry.js";
import { categoryRulesMaterializer } from "./category-rules.js";
import { transactionsMaterializer } from "./transactions.js";

export const budgetModule: StoreModule = {
  id: "budget",
  materializers: [transactionsMaterializer, categoryRulesMaterializer],
};
