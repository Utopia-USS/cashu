// The budget store module: transactions (imports, cash expenses, claims), merchant category rules,
// import batches, the cushion settings, and the derivers of the derived columns and cash legs.
import type { StoreModule } from "../registry.js";
import { categoryRulesMaterializer } from "./category-rules.js";
import { categoriesDeriver } from "./derive/categories.js";
import { legsDeriver } from "./derive/legs.js";
import { transfersDeriver } from "./derive/transfers.js";
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
  // Order matters (each sees the previous one's writes): legs (transfer matching reads them), then
  // transfers (categories read `is_internal_transfer` and take its flipped rows), then categories.
  derivers: [legsDeriver, transfersDeriver, categoriesDeriver],
  netWorth: budgetNetWorth,
  setup: budgetSetup,
};
