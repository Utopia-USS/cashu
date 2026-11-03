// The core store module: the profile, its modules, accounts (identity + view), balances, proposals,
// connector bindings. Its typed queries for screens are exported here (`@cashu/store/core`).
import type { StoreModule } from "../registry.js";
import { accountIdentity, accountsMaterializer } from "./accounts.js";
import { balancesMaterializer } from "./balances.js";
import { connectorBindingsMaterializer } from "./connector-bindings.js";
import { profileModulesMaterializer } from "./profile-modules.js";
import { profilesMaterializer } from "./profiles.js";
import { proposalsMaterializer } from "./proposals.js";

export * from "./mcp-queries.js";
export * from "./proposal-commands.js";
export * from "./proposal-execution.js";
export * from "./proposal-service.js";
export { accountByGid, enabledModuleIds, type ProfileView, profile } from "./queries.js";

export const coreModule: StoreModule = {
  id: "core",
  identityKinds: [accountIdentity],
  materializers: [
    profilesMaterializer,
    profileModulesMaterializer,
    accountsMaterializer,
    balancesMaterializer,
    proposalsMaterializer,
    connectorBindingsMaterializer,
  ],
};
