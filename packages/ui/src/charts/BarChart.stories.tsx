// Stories of the bar chart (synthetic data): monthly bars, a plan line with planned bars, value labels,
// muted bars, zero months, empty and privacy mode.
import { BarChart } from "./BarChart.js";
import { type Meta, privacyMode, type Story } from "./testing/csf.js";
import type { BarChartProps } from "./types.js";

const labels = ["01", "02", "03", "04", "05", "06"];
const values = [2000, 500, 0, 2500, 1800, 2200];

const meta = {
  title: "Charts/BarChart",
  component: BarChart,
  args: { label: "Contributions", width: 360, values, labels },
} satisfies Meta<BarChartProps>;
export default meta;

export const Monthly: Story<BarChartProps> = {};

export const WithPlan: Story<BarChartProps> = {
  args: {
    plan: 2000,
    planLabel: "Plan 2k",
    values: [2000, 500, 0, 2500, 0, 0],
    kinds: ["main", "main", "main", "main", "plan", "plan"],
  },
};

export const ValueLabels: Story<BarChartProps> = {
  args: { valueLabels: values.map((v) => (v ? `${v / 1000}k` : null)), height: 140 },
};

export const Muted: Story<BarChartProps> = {
  args: { kinds: ["muted", "muted", "muted", "main", "main", "main"] },
};

export const AllZero: Story<BarChartProps> = { args: { values: [0, 0, 0, 0, 0, 0] } };

export const Empty: Story<BarChartProps> = { args: { values: [], labels: [] } };

export const PrivacyMode: Story<BarChartProps> = {
  args: { ...ValueLabels.args },
  decorators: [privacyMode],
};
