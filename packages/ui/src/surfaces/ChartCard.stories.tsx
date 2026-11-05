import type { Meta, Story } from "../charts/testing/csf.js";
import { ChartCard, type ChartCardProps } from "./ChartCard.js";

const meta = {
  title: "Surfaces/ChartCard",
  component: ChartCard,
  args: { title: "Expenses", children: "Chart" },
} satisfies Meta<ChartCardProps>;
export default meta;
export const Default: Story<ChartCardProps> = {};
