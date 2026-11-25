import { InvestmentsSummaryWidgetView } from "./InvestmentsWidgetView.js";
import type { InvestmentsSummaryModel } from "./investmentsModel.js";

const m: InvestmentsSummaryModel = {
  title: "Investments",
  count: "12 mo",
  link: { label: "Investments", onPress: () => {} },
  facts: [
    { label: "YTD", value: "+4.0%", tone: "positive", detail: "MSCI ACWI +3.1%" },
    { label: "Opportunities", value: "1", detail: "SYN" },
    { label: "Risks", value: "2", detail: null },
  ],
  chart: { label: "Portfolio value, 12 months", values: [100, 104, 103, 108] },
  review: [{ text: "weekly review: " }, { text: "to do", bold: true }],
  rules: [{ text: "rules ok · " }, { text: "2.11", bold: true }],
};

export default {
  title: "Desktop/Overview/Investments",
  component: InvestmentsSummaryWidgetView,
  args: { m },
};
export const Ready = {};
export const NoChart = { args: { m: { ...m, chart: null, review: null } } };
export const Privacy = {
  args: { m: { ...m, chart: null, facts: m.facts.map((f) => ({ ...f, detail: "•••" })) } },
};
