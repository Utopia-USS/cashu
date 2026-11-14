import { ScrollableChart, type ScrollableChartProps } from "./ScrollableChart.js";
import type { Meta, Story } from "./testing/csf.js";

const meta = {
  title: "Charts/ScrollableChart",
  component: ScrollableChart,
  args: {
    title: "Cash flow (PLN)",
    label: "Cash flow",
    ranges: [
      ["6M", 6],
      ["Max", null],
    ],
    range: 6,
    onRangeChange: () => {},
    labels: ["2026-01", "2026-02", "2026-03"],
    bars: [
      { name: "Income", values: [5000, 5200, 4900], color: "positive" },
      { name: "Expenses", values: [3100, 4000, 2800], color: "negative" },
    ],
    line: { name: "Net", values: [1900, 1200, 2100], color: "net" },
    yFormat: (v: number) => String(v),
  },
} satisfies Meta<ScrollableChartProps>;
export default meta;
export const Default: Story<ScrollableChartProps> = {};
export const Loading: Story<ScrollableChartProps> = { args: { labels: [], bars: [] } };
export const TimeLine: Story<ScrollableChartProps> = {
  args: {
    title: "Saldo · Hipoteka",
    ranges: [
      ["1R", 365],
      ["Max", null],
    ],
    range: null,
    labels: ["2026-01-05", "2026-02-05", "2026-03-05"],
    span: 59,
    time: {
      xs: [Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 5), Date.UTC(2026, 2, 5)],
      tickFormat: (ms: number) => new Date(ms).toISOString().slice(0, 7),
      minTickGap: 40,
    },
    bars: [],
    line: { name: "Saldo", values: [12000, 11000, 10000], color: "negative", dots: false },
  },
};
