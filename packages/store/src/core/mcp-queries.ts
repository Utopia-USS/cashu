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
