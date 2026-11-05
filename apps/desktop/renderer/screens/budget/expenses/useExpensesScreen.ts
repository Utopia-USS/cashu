// Screen hook of the Wydatki tab (ab24ab6 modules/budget/Expenses.tsx): native vault queries and commands adapted
// to the old view (period navigation, spending donut, drill-down table with the category select, the toast that
// offers to apply a change to the merchant's other transactions). State lives in the route's search filters.
import { budget, type IsoDate } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S as C } from "@cashu/i18n/budget/CategoriesDrawer.strings";
import { S } from "@cashu/i18n/budget/Expenses.strings";
import { setTransactionCategory } from "@cashu/store";
import {
  budgetDesktopQueries,
  budgetScreenCashflow,
  budgetScreenSpending,
  setDesktopMerchantCategory,
} from "@cashu/store/budget/queries";
import { useCommand, useQuery } from "@cashu/store-react";
import { type SelectOption, useToast, useUiEnv } from "@cashu/ui";
import { cur } from "@cashu/ui-logic/core/format";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { type BudgetCurrency, useBudgetCurrency } from "./budgetCurrency.js";
import { E } from "./ExpensesNative.strings.js";
import { MASK, type Mode, type Period, periodLabel, spendingSlices } from "./expensesModel.js";

const queries = budgetDesktopQueries();

export interface ExpensesFilters {
  currency?: string;
  mode?: Mode;
  anchor?: number;
  drill?: string;
  sort?: "date" | "amount";
  order?: "asc" | "desc";
}

export interface ExpensesScreenOptions {
  today: IsoDate;
  filters: ExpensesFilters;
  /** The whole next filter object (the route writes it to the search). */
  onFilters(next: ExpensesFilters): void;
}

interface DrillRowView {
  key: string;
  date: string;
  merchant: string;
  details: string | null;
  account: string;
  amount: string;
  negative: boolean;
  category: string;
}

export function useExpensesScreen({ today, filters: f, onFilters }: ExpensesScreenOptions) {
  const { privacy } = useUiEnv();
  const toast = useToast();
  const patch = (values: Partial<ExpensesFilters>) => onFilters({ ...f, ...values });
  const bc: BudgetCurrency = useBudgetCurrency({
    today,
    requested: f.currency,
    onChange: (currency) => patch({ currency }),
  });
  const currency = bc.currency;
  // Only the month range for the navigation comes from these rows (last 240 months, as the old request).
  const flow = useQuery(budgetScreenCashflow, { today, currency, period: {} });
  const months = flow.rows
    .slice(-240)
    .map((row) => Number(row.label.slice(0, 4)) * 12 + Number(row.label.slice(5)) - 1);
  const min = months[0] ?? 0;
  const max = months.at(-1) ?? min;
  const mode: Mode = f.mode ?? "month";
  const scale = mode === "year" ? 12 : mode === "quarter" ? 3 : 1;
  const first = Math.floor(min / scale);
  const last = Math.floor(max / scale);
  const anchor = Math.max(first, Math.min(last, f.anchor ?? last));
  const ym = anchor * scale;
  const period: Period =
    mode === "all" || months.length === 0
      ? {}
      : {
          year: Math.floor(ym / 12),
          ...(mode === "month"
            ? { month: (ym % 12) + 1 }
            : mode === "quarter"
              ? { quarter: Math.floor((ym % 12) / 3) + 1 }
              : {}),
        };
  const spending = useQuery(budgetScreenSpending, { today, currency, period, lang: lang() });
  const donut = spendingSlices(
    spending.rows.map((r) => ({
      category: r.category,
      label: r.label,
      amount: r.amount.toFloat(),
    })),
    spending.currency,
  );

  const sort = f.sort ?? "date";
  const order = f.order ?? "desc";
  const drillRows = useQuery(queries.drill, {
    category: f.drill ?? "",
    currency,
    period,
    sort,
    order,
  });
  const categories = budget.CATEGORIES.map((c) => ({
    key: c.key,
    label: budget.categoryLabel(c.key, lang()),
    kind: c.kind,
  }));
  const labelFor = (key: string) => categories.find((c) => c.key === key)?.label ?? key;
  const drillOptions: SelectOption[] = [
    ...categories
      .filter((c) => c.kind !== "transfer")
      .map((c) => ({ value: c.key, label: c.label })),
    { value: "cash_withdrawal", label: S.cashWithdrawal },
  ];

  const categoryCommand = useCommand(setTransactionCategory);
  const merchantCommand = useCommand(setDesktopMerchantCategory);
  const durable = useDurableCommands();

  const applyMerchant = async (merchantKey: string, category: string) => {
    const result = await durable.run(`merchant:${merchantKey}`, merchantCommand, {
      merchantKey,
      category,
    });
    if (result.kind === "completed")
      toast(`${labelFor(category)} · ${S.nTransactions(result.value.updated)}`, 9000);
    else toast(commandFailure(result), 9000);
  };

  // A manual change affects only this transaction; the toast offers the merchant's other ones.
  const markCategory = async (txn: string, category: string) => {
    const row = drillRows.find((r) => r.key === txn);
    if (!row) return;
    const result = await durable.run(`category:${txn}`, categoryCommand, { txn, category });
    if (result.kind !== "completed") {
      toast(C.notSaved(commandFailure(result)), 9000);
      return;
    }
    if (category === "cash_withdrawal" || !row.merchantKey) return;
    const merchantKey = row.merchantKey;
    const name = row.counterparty || row.merchant || merchantKey;
    toast(S.changed(labelFor(category)), 9000, {
      label: privacy ? E.allFromMerchant : S.allFrom(name),
      onClick: () => void applyMerchant(merchantKey, category),
    });
  };

  const drill = f.drill
    ? {
        title: S.transactionsOf(labelFor(f.drill)),
        sort,
        order,
        rows: drillRows.map(
          (r): DrillRowView => ({
            key: r.key,
            date: r.date,
            merchant: privacy ? MASK : r.merchant || "-",
            details: r.details ? (privacy ? MASK : r.details) : null,
            account: privacy ? MASK : r.account || "-",
            amount: cur(r.amount.toFloat(), r.currency),
            negative: r.amount.toFloat() < 0,
            category: r.category ?? "other",
          }),
        ),
      }
    : null;

  return {
    bc,
    mode,
    periodLabel: periodLabel(mode, period, S.wholePeriod),
    canNav: mode !== "all",
    step: (delta: -1 | 1) => patch({ anchor: Math.max(first, Math.min(last, anchor + delta)) }),
    switchMode: (next: Mode) => {
      const nextScale = next === "year" ? 12 : next === "quarter" ? 3 : 1;
      patch({ mode: next, anchor: Math.floor(ym / nextScale) });
    },
    slices: donut.slices,
    total: donut.total,
    openDrill: (key: string) => patch({ drill: key }),
    drill,
    drillOptions,
    busy: categoryCommand.isPending || merchantCommand.isPending,
    setSort: (s: "date" | "amount") => patch({ sort: s }),
    setOrder: (o: "asc" | "desc") => patch({ order: o }),
    closeDrill: () => patch({ drill: undefined }),
    markCategory: (txn: string, category: string): void => {
      void markCategory(txn, category);
    },
  };
}
export type ExpensesState = ReturnType<typeof useExpensesScreen>;
