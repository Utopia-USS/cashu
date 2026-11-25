import type { Meta, Story } from "../charts/testing/csf.js";
import { LegendRow, type LegendRowProps } from "./LegendRow.js";

const meta = {
  title: "Lists/LegendRow",
  component: LegendRow,
  args: { swatch: "palette-1", label: "Groceries", amount: "445.70", share: "9%" },
} satisfies Meta<LegendRowProps>;
export default meta;
export const Default: Story<LegendRowProps> = {};
