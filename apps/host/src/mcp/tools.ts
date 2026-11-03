// TRANSITIONAL(S38f): the Python MCP server's tools, by the S38 slice that ports them (scopes-v2.md).
// Until a slice lands every tool is served by the Python child of the session (python.ts); the slices
// move tools into the host one group at a time, and the session then merges the lists (TS tools win
// by name). The Python registry is checked against this table (python.test.ts), so a tool added in
// Python cannot go unassigned. This tracks implementation coverage, not default routing: the host
// may retain delegation where native dependencies or the mixed-source write contract are unsettled.
import { mcpToolMetadata } from "@cashu/mcp";

export const PYTHON_TOOLS: Readonly<Record<string, string>> = {
  // TRANSITIONAL(S38b): classification awaits the native learned-rule write contract.
  set_merchant_category: "S38b",
  // TRANSITIONAL(S38d): async network lookup and checked encrypted import publication.
  // Native add_to_watchlist is currently the existing-instrument branch; remote resolution remains S38d.
  propose_import: "S38d",
  search_instruments: "S38d",
  // TRANSITIONAL(S38f): connector tools
  test_connector: "S38f",
  propose_connector: "S38f",
  connectors: "S38f",
};

/** Complete provider order and module ownership for native and delegated handlers. */
export const TOOL_INVENTORY = mcpToolMetadata();
