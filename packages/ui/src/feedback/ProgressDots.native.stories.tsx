import type { Meta, Story } from "../charts/testing/csf.js";
import { ProgressDots, type ProgressDotsProps } from "./ProgressDots.js";

const meta = {
  title: "Native/ProgressDots",
  component: ProgressDots,
  args: { total: 5, done: 2 },
} satisfies Meta<ProgressDotsProps>;
export default meta;
export const Default: Story<ProgressDotsProps> = {};
export const None: Story<ProgressDotsProps> = { args: { done: 0 } };
export const All: Story<ProgressDotsProps> = { args: { done: 5 } };
