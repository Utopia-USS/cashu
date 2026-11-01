// Native per-call provider composition; module state never disables retained-name protection.
import { builtinRegistry, ownIbans } from "@cashu/domain/core";
import { mcpBudgetNameRows } from "@cashu/store/budget/queries";
import { mcpAccounts, mcpProfile } from "@cashu/store/core";
import { loadInstruments, overrides, vaultInstrumentGids } from "@cashu/store/investments/queries";
import type { Read } from "@cashu/store/query";
import { accountLabels } from "../privacy/accounts.js";
import { collectGuard, type NameSources, type SecretSource } from "../privacy/names.js";
import { budgetNameSources } from "./budget.js";
import { type InvestmentNameRow, investmentNameSources } from "./investments.js";

export { type BudgetNameRow, budgetNameSources } from "./budget.js";
export { type InvestmentNameRow, investmentNameSources, ownerNamed } from "./investments.js";
export function loadNameSources(read: Read): NameSources[] {
  const ids = vaultInstrumentGids(read);
  const named = overrides(read);
  const wanted = new Set([...ids, ...named.keys()]);
  const own = loadInstruments(read, wanted);
  const shared = loadInstruments(read, wanted, { shared: true });
  const rows: InvestmentNameRow[] = [];
  for (const id of wanted) {
    const mine = own.get(id);
    const base = shared.get(id);
    if (mine && base)
      rows.push({
        inProfile: ids.has(id),
        own: mine,
        shared: base,
        overrideName: named.get(id)?.name ?? null,
      });
  }
  return [
    budgetNameSources(mcpBudgetNameRows(read), ownIbans(mcpAccounts(read))),
    investmentNameSources(rows),
  ];
}
export function loadAccountLabels(read: Read): Map<number | bigint, string> {
  return accountLabels<number | bigint>(mcpAccounts(read), (bank) =>
    builtinRegistry().institutions.displayName(bank, "pl"),
  );
}
/** The caller supplies a stable vault identity, never the vault-local profile row id. */
export function loadGuard(read: Read, profileId: number | bigint, secret?: SecretSource) {
  return collectGuard({
    profileId,
    profileName: mcpProfile(read)?.name ?? null,
    accountNames: mcpAccounts(read).map((a) => a.name),
    providers: loadNameSources(read),
    ...(secret ? { secret } : {}),
  });
}
