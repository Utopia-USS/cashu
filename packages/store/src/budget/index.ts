// The budget store module: transactions (imports, cash expenses, claims), merchant category rules,
// import batches, the cushion settings, and the derivers of the derived columns and cash legs.
import type { StoreModule } from "../registry.js";
import { categoryRulesMaterializer } from "./category-rules.js";
import { categoriesDeriver } from "./derive/categories.js";
import { legsDeriver } from "./derive/legs.js";
import { monthsDeriver } from "./derive/months.js";
import { recurringDeriver } from "./derive/recurring.js";
import { searchDeriver } from "./derive/search.js";
import { transfersDeriver } from "./derive/transfers.js";
import { importBatchesMaterializer } from "./import-batches.js";
import { budgetNetWorth, budgetSetup } from "./read-models.js";
import { budgetSettingsMaterializer } from "./settings.js";
import { transactionsMaterializer } from "./transactions.js";
import { transferRunsMaterializer } from "./transfer-runs.js";

export const budgetModule: StoreModule = {
  id: "budget",
  materializers: [
    transactionsMaterializer,
    transferRunsMaterializer,
    categoryRulesMaterializer,
    importBatchesMaterializer,
    budgetSettingsMaterializer,
  ],
  // Order matters (each sees the previous one's writes): legs (transfer matching reads them), then
  // transfers (categories read `is_internal_transfer` and take its flipped rows), then categories,
  // then the recurring payments (they read the rows whose category or transfer flag changed), then
  // the month aggregates (they take those rows); the search index last (it reads the rows' texts,
  // cash legs included). The last three are companion derivers (`Deriver.companion`): registered only
  // with `StoreOptions.companionReads` (the phone), so they stay after every other deriver.
  derivers: [
    legsDeriver,
    transfersDeriver,
    categoriesDeriver,
    recurringDeriver,
    monthsDeriver,
    searchDeriver,
  ],
  netWorth: budgetNetWorth,
  setup: budgetSetup,
};
