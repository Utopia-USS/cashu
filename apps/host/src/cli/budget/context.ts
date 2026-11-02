import { mcpProfile } from "@cashu/store/core";
import type { StrategyFilesPort } from "@cashu/store/investments/services";
import type { HostStores, OpenVault } from "../../stores.js";
import { supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import type { CategorizeProvider } from "./categorizeOllama.js";

export interface BudgetCliDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  /** Authoritative vault-scoped file port; absent while production strategy files are unbound. */
  readonly strategyFiles?: (vault: OpenVault, profileSlug: string) => StrategyFilesPort | null;
  /** A coherent local classifier transport and actual vault-holder check. */
  readonly classifier?: CategorizeProvider;
}

/** A native CLI financial read or write always names one already-open vault. */
export function budgetVault(
  io: CommandIo,
  root: { readonly profile?: string },
  stores: Pick<HostStores, "vaults">,
): OpenVault | null {
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug || !supportsConsoleUnicode(io)) return null;
  const matches = [...stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function localDate(now: number): string {
  const d = new Date(now);
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
