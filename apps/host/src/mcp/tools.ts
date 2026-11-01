// TRANSITIONAL(S38f): the Python MCP server's tools, by the S38 slice that ports them (scopes-v2.md).
// Until a slice lands every tool is served by the Python child of the session (python.ts); the slices
// move tools into the host one group at a time, and the session then merges the lists (TS tools win
// by name). The Python registry is checked against this table (python.test.ts), so a tool added in
// Python cannot go unassigned.
import { mcpToolMetadata } from "@cashu/mcp";

export const PYTHON_TOOLS: Readonly<Record<string, string>> = {
  // TRANSITIONAL(S38b): budget and loans tools
  spending_breakdown: "S38b",
  cashflow_summary: "S38b",
  recurring_payments: "S38b",
  uncategorized_merchants: "S38b",
  set_merchant_category: "S38b",
  validate_budget_import: "S38b",
  loans_summary: "S38b",
  // TRANSITIONAL(S38c): investments read tools
  portfolio_overview: "S38c",
  positions: "S38c",
  signals: "S38c",
  review_context: "S38c",
  strategy_status: "S38c",
  history_metrics: "S38c",
  theses: "S38c",
  inspect_export: "S38c",
  validate_import: "S38c",
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

/** Complete provider order and module ownership, including native core tools. */
export const TOOL_INVENTORY = mcpToolMetadata();
