import type { Meta, Story } from "../charts/testing/csf.js";
import { Pill, type PillProps } from "./Tag.js";

const meta = {
  title: "Surfaces/Pill",
  component: Pill,
  args: { tone: "negative", children: "2 risks" },
} satisfies Meta<PillProps>;
export default meta;
export const Default: Story<PillProps> = {};
