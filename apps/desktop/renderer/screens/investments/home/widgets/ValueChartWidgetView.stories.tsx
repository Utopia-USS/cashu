import { ValueChartWidgetView } from "./ValueChartWidgetView.js";
import type { ValueChartWidgetProps } from "./valueChartModel.js";

const values = [100, 104, 103, 108, 112, 111, 118];
const args: ValueChartWidgetProps = {
  title: "Value vs benchmark",
  rangeLabel: "Range",
  ranges: [
    ["1M", "1m"],
    ["1Y", "1y"],
  ],
  range: "1y",
  onRange() {},
  legend: [
    { label: "portfolio", mark: "main", stacked: true },
    { label: "Synthetic index in PLN, same contributions", mark: "bench" },
  ],
  body: {
    kind: "chart",
    chart: {
      label: "Synthetic portfolio value",
      height: 230,
      padL: 56,
      padR: 150,
      valueKind: "share",
      series: [
        { values: values.map((v) => v - 2), tone: "bench", color: "bench", endLabel: "index 116" },
        { values, color: "accent", area: true, endLabel: "portfolio 118" },
      ],
    },
  },
  footer: {
    facts: [
      { lead: "12 months TWR ", value: "+18.0%" },
      { lead: "XIRR ", value: "9.1%" },
    ],
    toggle: { text: "table", pressed: false, onToggle() {} },
  },
};

export default {
  title: "Desktop/Investments/Home/ValueChartWidget",
  component: ValueChartWidgetView,
};
export const Ready = { args };
export const Empty = {
  args: { ...args, footer: null, body: { kind: "empty", text: "Not enough history." } },
};
