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
  // TRANSITIONAL(S38d): investments write, alerts and watchlist tools
  set_recommendation: "S38d",
  set_recommendations: "S38d",
  record_decision: "S38d",
  upsert_thesis: "S38d",
  propose_strategy: "S38d",
  propose_custom_rule: "S38d",
  propose_import: "S38d",
  alerts: "S38d",
  add_alert: "S38d",
  mute_alert: "S38d",
  watchlist: "S38d",
  search_instruments: "S38d",
  add_to_watchlist: "S38d",
  remove_from_watchlist: "S38d",
  // TRANSITIONAL(S38e): research tools
  research_context: "S38e",
  research_notes: "S38e",
  start_research_run: "S38e",
  add_research_note: "S38e",
  set_topic_market_view: "S38e",
  upsert_topic_thesis: "S38e",
  finish_research_run: "S38e",
  set_instrument_segment: "S38e",
  // TRANSITIONAL(S38f): connector tools
  test_connector: "S38f",
  propose_connector: "S38f",
  connectors: "S38f",
};

/** Complete provider order and module ownership for native and delegated handlers. */
export const TOOL_INVENTORY = mcpToolMetadata();
