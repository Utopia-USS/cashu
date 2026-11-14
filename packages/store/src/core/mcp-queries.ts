// Core-owned read adapters for MCP. Each Read is already bound to one vault.
import type { Read } from "../query.js";
import { enabledModuleIds, type ProfileView } from "./queries.js";

export interface McpProfile extends ProfileView {
  readonly slug: string;
  readonly modules: readonly string[];
}
export function mcpProfile(read: Read): McpProfile | undefined {
  const row = read<Omit<McpProfile, "modules">>(
    "SELECT slug, name, base_currency AS baseCurrency, mcp_privacy AS mcpPrivacy FROM profiles",
  )[0];
  return row ? { ...row, modules: [...enabledModuleIds(read)] } : undefined;
}
export interface McpAccount {
  readonly id: number;
  readonly gid: string;
  readonly name: string;
  readonly bank: string;
  readonly type: string;
  readonly iban: string | null;
}
/** Full creation order, including removed accounts: labels and retained names stay stable. */
export function mcpAccounts(read: Read): McpAccount[] {
  return read<McpAccount>("SELECT id, gid, name, bank, type, iban FROM accounts ORDER BY id");
}
export function mcpCoreFreshness(read: Read): {
  balancesNewest: string | null;
  pendingProposals: number;
} {
  return {
    balancesNewest:
      read<{ newest: string | null }>("SELECT MAX(date) AS newest FROM balances")[0]?.newest ??
      null,
    pendingProposals:
      read<{ count: number }>("SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'")[0]
        ?.count ?? 0,
  };
}
