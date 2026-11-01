// The budget store module: transactions (imports, cash expenses, claims), merchant category rules,
// import batches, the cushion settings, and the derivers of the derived columns and cash legs.
import type { StoreModule } from "../registry.js";
import { categoryRulesMaterializer } from "./category-rules.js";
import { categoriesDeriver } from "./derive/categories.js";
import { legsDeriver } from "./derive/legs.js";
import { importBatchesMaterializer } from "./import-batches.js";
import { budgetNetWorth, budgetSetup } from "./read-models.js";
import { budgetSettingsMaterializer } from "./settings.js";
import { transactionsMaterializer } from "./transactions.js";

export const budgetModule: StoreModule = {
  id: "budget",
  materializers: [
    transactionsMaterializer,
    categoryRulesMaterializer,
    importBatchesMaterializer,
    budgetSettingsMaterializer,
  ],
  // Order matters (each sees the previous one's writes): legs, then categories (S24b adds transfers
  // before categories).
  derivers: [legsDeriver, categoriesDeriver],
  netWorth: budgetNetWorth,
  setup: budgetSetup,
};
