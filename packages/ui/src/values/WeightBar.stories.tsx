import type { Meta, Story } from "../charts/testing/csf.js";
import { WeightBar, type WeightBarProps } from "./WeightBar.js";

const meta = {
  title: "Values/WeightBar",
  component: WeightBar,
  args: { fill: 60, text: "12.4 %" },
} satisfies Meta<WeightBarProps>;
export default meta;
export const Default: Story<WeightBarProps> = {};
