import { ValueChartWidgetView } from "./ValueChartWidgetView.js";
import type { ValueChartWidgetProps } from "./valueChartModel.js";

const values = [100, 104, 103, 108, 112, 111, 118];
const args: ValueChartWidgetProps = {
  title: "Value vs benchmark",
  sub: "Synthetic index in PLN, same contributions",
  rangeLabel: "Range",
  ranges: [
    ["1M", "1m"],
    ["1Y", "1y"],
  ],
  range: "1y",
  onRange() {},
  toggle: { text: "table", pressed: false, onToggle() {} },
  legend: [
    { key: "portfolio", label: "Portfolio", mark: "main" },
    { key: "bench", label: "Synthetic index", mark: "bench", value: "+19.1%" },
    { key: "difference", label: "Difference", mark: null, value: "-1.1 pp", tone: "negative" },
  ],
  status: null,
  body: {
    kind: "chart",
    chart: {
      label: "Synthetic portfolio value",
      height: 250,
      padL: 56,
      padR: 150,
      valueKind: "share",
      series: [
        { values: values.map((v) => v - 2), tone: "bench", color: "bench", endLabel: "index 116" },
        { values, color: "accent", area: true, endLabel: "portfolio 118" },
      ],
    },
  },
  kpis: [
    {
      key: "ytd",
      label: "Year to date",
      value: "-0.1%",
      lines: [
        {
          key: "range",
          parts: [
            { text: "12 months TWR " },
            { text: "+1.7%", tone: "positive" },
            { text: " · XIRR 2.4%" },
          ],
        },
        {
          key: "bench",
          parts: [{ text: "Synthetic index +0.5% · " }, { text: "-0.6 pp", tone: "negative" }],
        },
      ],
    },
    {
      key: "unrealized",
      label: "Unrealized return",
      value: "+1,734",
      tone: "positive",
      lines: [{ key: "detail", parts: [{ text: "+3.7% vs cost" }] }],
    },
    {
      key: "drawdown",
      label: "Drawdown",
      value: "-2.6%",
      lines: [{ key: "detail", parts: [{ text: "max -9.7%" }] }],
    },
    {
      key: "contributions",
      label: "Contributions",
      value: "22,500",
      bar: 0.82,
      lines: [
        { key: "detail", parts: [{ text: "plan 27,500 · 1 month without a contribution" }] },
        { key: "range-contributions", parts: [{ text: "contributions 12 months 27,500" }] },
      ],
    },
  ],
};

export default {
  title: "Desktop/Investments/Home/ValueChartWidget",
  component: ValueChartWidgetView,
};
export const Ready = { args };
export const BenchmarkOutOfDate = {
  args: {
    ...args,
    legend: args.legend.slice(0, 2).map((e) => ({ ...e, value: undefined })),
    status: { text: "benchmark out of date", title: "Last quote 12.10", warn: true },
  },
};
export const Table = {
  args: {
    ...args,
    toggle: { text: "chart", pressed: true, onToggle() {} },
    body: {
      kind: "table",
      columns: [
        { label: "Date", num: false },
        { label: "Portfolio", num: true },
      ],
      rows: [{ key: "2026-01-01", cells: ["2026-01-01", "1,000"] }],
    },
  },
};
export const Empty = {
  args: {
    ...args,
    toggle: null,
    kpis: [],
    body: { kind: "empty", text: "Not enough history." },
  },
};
