// Stories of the stacked area chart (synthetic data): assets and a liability, one fading layer, the
// interactive tooltip, empty and privacy mode.
import { AreaChart } from "./AreaChart.js";
import { type Meta, privacyMode, type Story } from "./testing/csf.js";
import { monthLabels, rising, thousands } from "./testing/data.js";
import type { AreaChartProps } from "./types.js";

const N = 18;
const cash = rising(N, 40_000, 800);
const home = rising(N, 450_000, 1_500, 500);
const loan = rising(N, -320_000, 1_200, 0);

const meta = {
  title: "Charts/AreaChart",
  component: AreaChart,
  args: {
    label: "Net worth by asset",
    width: 640,
    layers: [
      { key: "cash", name: "Cash", color: 1, values: cash },
      { key: "home", name: "Property", color: 6, values: home },
      { key: "loan", name: "Mortgage", color: 7, values: loan },
    ],
    xLabels: monthLabels(N, [0, 6, 12, 17]),
    yFormat: thousands,
  },
} satisfies Meta<AreaChartProps>;
export default meta;

export const Stacked: Story<AreaChartProps> = {};

export const SingleLayer: Story<AreaChartProps> = {
  args: { label: "Cash", layers: [{ key: "cash", name: "Cash", color: 1, values: cash }] },
};

export const Interactive: Story<AreaChartProps> = {
  args: {
    tooltip: (i) => ({
      title: `${String((i % 12) + 1).padStart(2, "0")}/25`,
      rows: [
        { name: "Cash", value: thousands(cash[i] ?? 0), amount: true, color: "series1" },
        { name: "Mortgage", value: thousands(loan[i] ?? 0), amount: true, color: "series7" },
      ],
    }),
  },
};

export const Empty: Story<AreaChartProps> = { args: { layers: [], xLabels: [] } };

export const PrivacyMode: Story<AreaChartProps> = {
  args: { ...Interactive.args },
  decorators: [privacyMode],
};
