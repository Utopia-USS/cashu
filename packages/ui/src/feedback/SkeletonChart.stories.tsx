import type { Meta, Story } from "../charts/testing/csf.js";
import { SkeletonChart, type SkeletonChartProps } from "./SkeletonChart.js";

const meta = {
  title: "Feedback/SkeletonChart",
  component: SkeletonChart,
  args: {},
} satisfies Meta<SkeletonChartProps>;
export default meta;
export const Default: Story<SkeletonChartProps> = {};
