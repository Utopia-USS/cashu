// The core store module: accounts (identity + view), proposals, connector bindings.
// S24 adds profiles, profile_modules, balances and the budget cushion settings.
import type { StoreModule } from "../registry.js";
import { accountIdentity, accountsMaterializer } from "./accounts.js";
import { connectorBindingsMaterializer } from "./connector-bindings.js";
import { proposalsMaterializer } from "./proposals.js";

export const coreModule: StoreModule = {
  id: "core",
  identityKinds: [accountIdentity],
  materializers: [accountsMaterializer, proposalsMaterializer, connectorBindingsMaterializer],
};
