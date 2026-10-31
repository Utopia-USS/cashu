/**
 * How each `store.table.<table>` producer rebuilds its table from the genesis roundtrip (S26 spec
 * 8.3): `view` = from the folded view of the table's S23 materializer (`project.ts`), `inverse` =
 * TRANSITIONAL(S24) / TRANSITIONAL(S25) from the genesis events (`inverse*.ts`) until the table's
 * materializer lands; the flip of a table to `view` is that scope's acceptance (the golden still passes).
 */

export type Mode = "view" | "inverse";

/** Tables folded by an S23 materializer. Every other synced table is `inverse`. */
export const VIEW_TABLES: ReadonlySet<string> = new Set([
  "accounts",
  "category_rules",
  "transactions",
  "watchlist_items",
  "inv_profile_instruments",
  "inv_manual_valuations",
  "inv_signals",
  "inv_decisions",
  "proposals",
  "connector_bindings",
]);

export const modeOf = (table: string): Mode => (VIEW_TABLES.has(table) ? "view" : "inverse");

/**
 * TRANSITIONAL(S24): rows of a view-mode table that its S23 materializer does not fold yet, taken
 * from the inverse of their event type: table -> event type -> why.
 */
export const PENDING_ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  transactions: {
    "txn.cashExpenseAdded": "cash expenses are folded by S24 (no S23 materializer handles them)",
  },
};

/**
 * TRANSITIONAL(S24): columns of a view-mode table its S23 materializer cannot reproduce yet, taken
 * from the inverse row of the same gid: table -> column -> why. A column is never dropped from the
 * comparison; it is listed here with its reason or it comes from the view.
 */
export const PENDING_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {};
