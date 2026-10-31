// The investments store module: instrument identity and every synced investments table (S23:
// watchlist, overrides, manual valuations, signals + decisions; S25: instruments + aliases, account
// settings, import batches, transactions, position snapshots, renames, strategy versions, rule runs,
// alerts, theses, topic theses, planned deposits, research runs + notes, reviews). Price, FX and macro
// caches and the notification log are device-local and never in the view (events.md 10).
import type { StoreModule } from "../registry.js";
import { accountSettingsMaterializer } from "./account-settings.js";
import { importBatchesMaterializer } from "./import-batches.js";
import { instrumentIdentity, instrumentsMaterializer } from "./instruments.js";
import { overridesMaterializer } from "./overrides.js";
import { positionsMaterializer, renamesMaterializer } from "./positions.js";
import { signalsMaterializer } from "./signals.js";
import { ruleRunsMaterializer, strategyMaterializer } from "./strategy.js";
import { transactionsMaterializer } from "./transactions.js";
import { valuationsMaterializer } from "./valuations.js";
import { watchlistMaterializer } from "./watchlist.js";

export const investmentsModule: StoreModule = {
  id: "investments",
  identityKinds: [instrumentIdentity],
  materializers: [
    instrumentsMaterializer,
    accountSettingsMaterializer,
    importBatchesMaterializer,
    transactionsMaterializer,
    positionsMaterializer,
    renamesMaterializer,
    watchlistMaterializer,
    overridesMaterializer,
    valuationsMaterializer,
    strategyMaterializer,
    ruleRunsMaterializer,
    signalsMaterializer,
  ],
};
