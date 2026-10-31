// The investments store module (S23 part: instrument identity, watchlist, overrides, manual
// valuations, signals + decisions). S25 adds the remaining inv_* tables, alerts, theses, research,
// strategy versions and the instruments view.
import type { StoreModule } from "../registry.js";
import { instrumentIdentity } from "./instruments.js";
import { overridesMaterializer } from "./overrides.js";
import { signalsMaterializer } from "./signals.js";
import { valuationsMaterializer } from "./valuations.js";
import { watchlistMaterializer } from "./watchlist.js";

export const investmentsModule: StoreModule = {
  id: "investments",
  identityKinds: [instrumentIdentity],
  materializers: [
    watchlistMaterializer,
    overridesMaterializer,
    valuationsMaterializer,
    signalsMaterializer,
  ],
};
