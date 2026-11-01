// The agent write remains delegated: Python's direct assignments differ from D-24.1 derivation.
import { type ToolSpec, toolSpec } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { validateBudgetImport } from "./budgetImport.js";
import {
  cashflowSummary,
  recurringPayments,
  spendingBreakdown,
  uncategorizedMerchants,
} from "./budgetRead.js";

const CURRENCY = {
  type: "string",
  maxLength: 3,
  description: "3-letter code (default: base currency)",
};
/** Python descriptors, in provider order; set_merchant_category is intentionally not native yet. */
export function budgetTools(): readonly ToolSpec<NativeToolStore>[] {
  return [
    toolSpec({
      name: "spending_breakdown",
      module: "budget",
      description:
        "Spending in a period (2026, 2026-09 or 2026-Q3; default: the latest month with data): category shares and top merchants with shares, in one currency.",
      handler: spendingBreakdown,
      properties: {
        period: { type: "string", maxLength: 7 },
        currency: CURRENCY,
        top: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    }),
    toolSpec({
      name: "cashflow_summary",
      module: "budget",
      description:
        "Savings rate %, income/expense ratio, months with a deficit over the last N months.",
      handler: cashflowSummary,
      properties: {
        months: { type: "integer", minimum: 1, maximum: 120, default: 12 },
        currency: CURRENCY,
      },
    }),
    toolSpec({
      name: "recurring_payments",
      module: "budget",
      description:
        "Recurring payments (likely subscriptions): merchant, cadence, share of monthly spending.",
      handler: recurringPayments,
    }),
    toolSpec({
      name: "uncategorized_merchants",
      module: "budget",
      description:
        "Merchants without a category (by count) and the list of category keys for set_merchant_category.",
      handler: uncategorizedMerchants,
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 30 } },
    }),
    toolSpec({
      name: "validate_budget_import",
      module: "budget",
      description:
        "Validate a cashu-budget-import document (JSON or CSV; e.g. your connector's or converter's output): ok, transaction and balance counts, date range, currencies, and issues by kind with row numbers and field names, no values. Nothing is imported.",
      handler: validateBudgetImport,
      properties: { path: { type: "string", maxLength: 1024 } },
      required: ["path"],
    }),
  ];
}
