// Investment-owned aggregation for core MCP tools; no cross-module private SQL.

import { lastReview } from "./reviews.js";
import type { Read } from "./shared.js";
export function mcpInvestmentTransactionCount(read: Read): number {
  return (
    read<{ count: number }>(`SELECT COUNT(*) AS count FROM inv_transactions t
    JOIN accounts a ON a.id = t.account_id WHERE a.type = 'brokerage'`)[0]?.count ?? 0
  );
}
export function mcpReviewStats(read: Read): Record<string, number> {
  const previous = lastReview(read, "investments");
  const rows = read<{ severity: string; count: number }>(`SELECT severity, COUNT(*) AS count
    FROM inv_signals WHERE status IN ('active', 'acknowledged') GROUP BY severity`);
  const count =
    read<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inv_decisions
    ${previous ? "WHERE created_at > ?" : ""}`,
      ...(previous ? [previous.doneAt] : []),
    )[0]?.count ?? 0;
  return {
    open_signals: rows.reduce((sum, row) => sum + row.count, 0),
    action_signals: rows.find((r) => r.severity === "action")?.count ?? 0,
    decisions_since_last_review: count,
  };
}
