import { BudgetMonthWidgetView } from "./OverviewWidgetsView.js";
import type { BudgetMonthModel } from "./overviewModel.js";

const m: BudgetMonthModel = {
  title: "Budget · October",
  tag: { text: "closed", tone: "positive" },
  link: { label: "Expenses", onPress: () => {} },
  rows: [
    { key: "in", label: "Income", fill: 100, tone: "accent", value: "11,800 PLN" },
    { key: "out", label: "Expenses", fill: 41, value: "4,786 PLN" },
    { key: "net", label: "Surplus", fill: 59, tone: "positive", value: "7,014 PLN" },
  ],
  empty: "No transactions from last month.",
  foot: [[{ text: "savings rate " }, { text: "59%", bold: true }]],
  others: null,
};

export default {
  title: "Desktop/Overview/Budget month",
  component: BudgetMonthWidgetView,
  args: { m },
};
export const Ready = {};
export const Empty = { args: { m: { ...m, rows: null, tag: null, foot: [] } } };
export const Privacy = {
  args: { m: { ...m, rows: (m.rows ?? []).map((r) => ({ ...r, value: "••• PLN" })) } },
};
