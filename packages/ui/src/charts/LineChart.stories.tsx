// Stories of the line chart (synthetic data): one series with an area, benchmark with end labels, levels
// and trade markers, a drawdown filled up to zero, gaps, the interactive tooltip, empty, privacy mode,
// no y axis and a narrow container.
import { LineChart } from "./LineChart.js";
import { type Meta, privacyMode, type Story } from "./testing/csf.js";
import { monthLabels, pct, rising, thousands } from "./testing/data.js";
import type { LineChartProps } from "./types.js";

const N = 24;
const worth = rising(N, 120_000, 2_500);
const bench = rising(N, 118_000, 2_000, 3_000);
const xLabels = monthLabels(N, [0, 6, 12, 18, 23]);

const meta = {
  title: "Charts/LineChart",
  component: LineChart,
  args: {
    label: "Net worth",
    width: 640,
    series: [{ values: worth, area: true, name: "Net worth" }],
    xLabels,
    yFormat: thousands,
  },
} satisfies Meta<LineChartProps>;
export default meta;

export const Default: Story<LineChartProps> = {};
export const ExactAmountSummary: Story<LineChartProps> = {
  args: {
    series: [
      {
        values: [9007199254740992, 9007199254740994],
        accessibleSummary:
          "Latest PLN 9,007,199,254,740,993.12; low PLN 9,007,199,254,740,992.01; high PLN 9,007,199,254,740,993.12",
      },
    ],
    yFormat: false,
    xLabels: [],
  },
};

export const WithBenchmark: Story<LineChartProps> = {
  args: {
    label: "Portfolio vs benchmark",
    series: [
      { values: worth, area: true, endLabel: "Portfolio" },
      { values: bench, tone: "bench", endLabel: "Benchmark" },
    ],
  },
};

export const LevelsAndMarkers: Story<LineChartProps> = {
  args: {
    label: "Price with alert levels",
    series: [{ values: worth, endLabel: "Price" }],
    levels: [
      { y: 170_000, kind: "alert", label: "Alert" },
      { y: 150_000, kind: "rule", label: "Rule", muted: true },
      { y: 130_000, kind: "cost", label: "Cost basis" },
      { y: 165_000, kind: "agent", label: "Agent" },
    ],
    markers: [
      { i: 4, kind: "buy" },
      { i: 15, kind: "sell" },
    ],
  },
};

export const Drawdown: Story<LineChartProps> = {
  args: {
    label: "Drawdown",
    valueKind: "share",
    series: [
      {
        values: Array.from({ length: N }, (_, i) => -Math.abs(Math.sin(i / 3)) * 8.4),
        tone: "negative",
        area: true,
        areaTo: 0,
      },
    ],
    ymax: 0,
    yFormat: pct,
    height: 110,
  },
};

export const Gaps: Story<LineChartProps> = {
  args: { series: [{ values: worth.map((v, i) => (i % 7 === 3 ? null : v)), name: "Net worth" }] },
};

export const Interactive: Story<LineChartProps> = {
  args: {
    series: [
      { values: worth, area: true, name: "Portfolio" },
      { values: bench, tone: "bench", name: "Benchmark" },
    ],
    tooltip: (i) => ({
      title: `${String((i % 12) + 1).padStart(2, "0")}/${25 + Math.floor(i / 12)}`,
      rows: [
        { name: "Portfolio", value: thousands(worth[i] ?? 0), amount: true, color: "series1" },
        { name: "Benchmark", value: thousands(bench[i] ?? 0), amount: true, color: "muted" },
      ],
    }),
  },
};

export const Empty: Story<LineChartProps> = { args: { series: [{ values: [] }], xLabels: [] } };

export const PrivacyMode: Story<LineChartProps> = {
  args: { ...Interactive.args },
  decorators: [privacyMode],
};

export const ShareInPrivacyMode: Story<LineChartProps> = {
  args: { ...Drawdown.args },
  decorators: [privacyMode],
};

export const NoYAxis: Story<LineChartProps> = { args: { yFormat: false, height: 120 } };

export const Narrow: Story<LineChartProps> = { args: { width: 160, height: 120 } };
