import { budget } from "@cashu/domain";
import { learnMerchantCategory } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import * as L from "../privacy/labels.js";
import { Redactor } from "../privacy/redactor.js";
import {
  type ToolArgs,
  type ToolContext,
  ToolError,
  type ToolSpec,
  toolSpec,
} from "../registry.js";
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
async function setMerchantCategory(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): Promise<L.LabelledTree> {
  const merchant = args.merchant;
  const category = args.category;
  if (typeof category !== "string" || !budget.CATEGORY_KEYS.includes(category))
    throw new ToolError("unknown category; uncategorized_merchants lists the categories");
  const keys = new Set(
    budgetBook(ctx.store.read)
      .transactions.map((t) => budget.merchantKey(t.counterpartyName, t.reference, t.description))
      .filter(Boolean),
  );
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const token = typeof merchant === "string" && /^payee:[a-p]{10}$/.test(merchant);
  const matches = [...keys].filter((key) =>
    token
      ? ctx.guard.resolve(merchant, [key]) === key
      : redactor.apply(L.merchant(key)) === merchant,
  );
  const key = matches.length === 1 ? matches[0] : null;
  if (!key) throw new ToolError("no such merchant in this profile's transactions", "not_found");
  const result = await ctx.store.run(learnMerchantCategory, { merchantKey: key, category });
  if (!result.ok) {
    if (result.reason === "no_merchant")
      throw new ToolError("no such merchant in this profile's transactions", "not_found");
    throw new ToolError("category update refused", "invalid");
  }
  return {
    merchant: L.merchant(key),
    category: L.category(result.value.category),
    updated_transactions: L.count(result.value.updated),
    rule: L.fixedText(
      result.value.kept && result.value.category !== category
        ? "kept: the owner set this merchant's category by hand"
        : "learned rule saved for this profile (like an LLM rule: the owner's manual choices win)",
    ),
  };
}

/** Python descriptors, in provider order. */
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
      name: "set_merchant_category",
      module: "budget",
      description:
        "Teach the profile a category for a merchant (a learned rule; also re-categorizes its transactions). merchant: the name as listed, or a payee:... reference.",
      handler: setMerchantCategory,
      properties: {
        merchant: { type: "string", maxLength: 200 },
        category: { type: "string", maxLength: 40 },
      },
      required: ["merchant", "category"],
      write: true,
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
