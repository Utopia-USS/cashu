import { budgetBook, budgetEngineContext, classifierMerchants } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import { vaultPaymentPatterns } from "@cashu/store/overview";
import { defineQuery, runQuery } from "@cashu/store/query";
import type { OpenVault } from "../../stores.js";

const query = defineQuery({
  id: "host.budget.classifierInput",
  run: (read, _args: undefined) => {
    const book = budgetBook(read);
    return {
      profile: mcpProfile(read),
      total: book.transactions.length,
      merchants: classifierMerchants(read),
      // Owner rules, account identities and payment patterns are classifier configuration too.
      ownership: budgetEngineContext(read, vaultPaymentPatterns(read)),
    };
  },
});

/** Call within this vault's synchronous queue step, before leaving the queue for network work. */
export function classifierInput(
  vault: OpenVault,
  slug: string,
  vaults: ReadonlyMap<string, OpenVault>,
) {
  if (vaults.get(vault.id) !== vault) return null;
  const initial = runQuery(vault.store, query, undefined);
  if (initial.value.profile?.slug !== slug) return null;
  const version = vault.store.version(initial.tables);
  return {
    ...initial.value,
    isCurrent: (requested: string): boolean => {
      // A closed/replaced vault must be rejected before consulting its store or version.
      if (requested !== vault.id || vaults.get(vault.id) !== vault) return false;
      try {
        return vault.store.version(initial.tables) === version;
      } catch {
        return false;
      }
    },
  };
}
