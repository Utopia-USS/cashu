// The assets store module: depreciation curves of vehicles and notes of manual positions. Manual
// positions themselves are core accounts and balances.
import type { StoreModule } from "../registry.js";
import { assetDetailsMaterializer } from "./asset-details.js";
import { depreciationsMaterializer } from "./depreciations.js";

export const assetsModule: StoreModule = {
  id: "assets",
  materializers: [depreciationsMaterializer, assetDetailsMaterializer],
};
