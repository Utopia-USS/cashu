// Stories of the chart legend (synthetic labels): the value chart's portfolio vs benchmark row.
import { ChartLegend } from "./ChartLegend.js";
import type { Meta, Story } from "./testing/csf.js";
import type { ChartLegendProps } from "./types.js";

const meta = {
  title: "Charts/ChartLegend",
  component: ChartLegend,
  args: {
    items: [
      { label: "Portfolio", mark: "main", stacked: true },
      { label: "Benchmark, same contributions", mark: "bench" },
    ],
  },
} satisfies Meta<ChartLegendProps>;
export default meta;

export const ValueVsBenchmark: Story<ChartLegendProps> = {};
