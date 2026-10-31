// The built-in store modules, in fold order. Every runtime (desktop utility process, phone, CLI)
// opens a vault's store with this list.
import { assetsModule } from "./assets/index.js";
import { budgetModule } from "./budget/index.js";
import { coreModule } from "./core/index.js";
import { investmentsModule } from "./investments/index.js";
import { loansModule } from "./loans/index.js";
import type { StoreModule } from "./registry.js";

export function builtinModules(): readonly StoreModule[] {
  return [coreModule, budgetModule, loansModule, assetsModule, investmentsModule];
}
