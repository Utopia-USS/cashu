// Budget-owned MCP inputs. Python account_ids_query includes retained transactions of removed accounts.
import type { Read } from "../query.js";

export {
  budgetCliCushionEnv,
  budgetCliSettings,
  type CashCliRow,
  type CashCliSnapshot,
  cashCliSnapshot,
} from "./cli-queries.js";
export { budgetBook, budgetEngineContext } from "./read-models.js";
export interface BudgetNameRow {
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly internal: boolean;
  readonly reference: string | null;
  readonly description: string | null;
}
export function mcpBudgetNameRows(read: Read): BudgetNameRow[] {
  return read<
    Omit<BudgetNameRow, "internal"> & { internal: number }
  >(`SELECT DISTINCT t.counterparty_name AS counterpartyName,
    t.counterparty_iban AS counterpartyIban, t.is_internal_transfer AS internal,
    CASE WHEN t.counterparty_name IS NULL THEN t.reference ELSE NULL END AS reference,
    CASE WHEN t.counterparty_name IS NULL THEN t.description ELSE NULL END AS description
    FROM transactions t JOIN accounts a ON a.id = t.account_id`).map((r) => ({
    ...r,
    internal: r.internal === 1,
  }));
}
export function mcpBudgetFreshness(read: Read): { newest: string | null; count: number } {
  return (
    read<{
      newest: string | null;
      count: number;
    }>(`SELECT MAX(t.booking_date) AS newest, COUNT(*) AS count
    FROM transactions t JOIN accounts a ON a.id = t.account_id`)[0] ?? { newest: null, count: 0 }
  );
}
