// The Wydatki tab body (ab24ab6 Expenses.tsx), mounted by the budget route (contract-E.md). Needs a ToastProvider
// above it; remount per vault and privacy is the route's.
import { Suspense } from "react";
import { ExpensesLoadingView, ExpensesView } from "./ExpensesView.js";
import { type ExpensesScreenOptions, useExpensesScreen } from "./useExpensesScreen.js";

export type { ExpensesFilters, ExpensesScreenOptions } from "./useExpensesScreen.js";

export function ExpensesScreen(props: ExpensesScreenOptions) {
  return (
    <Suspense fallback={<ExpensesLoadingView />}>
      <BoundExpenses {...props} />
    </Suspense>
  );
}

function BoundExpenses(props: ExpensesScreenOptions) {
  return <ExpensesView state={useExpensesScreen(props)} />;
}
