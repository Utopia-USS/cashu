import type { Meta, Story } from "../charts/testing/csf.js";
import { PaceMeter, type PaceMeterProps } from "./Meter.js";

const meta = {
  title: "Native/PaceMeter",
  component: PaceMeter,
  args: {
    spentShare: 0.48,
    usualShare: 0.4,
    labelLeft: "Spent 48% of a usual month",
    labelRight: "a bit ahead of usual",
  },
} satisfies Meta<PaceMeterProps>;
export default meta;
export const Default: Story<PaceMeterProps> = {};
export const Behind: Story<PaceMeterProps> = {
  args: { spentShare: 0.3, labelRight: "below usual", rightTone: "positive" },
};
export const Over: Story<PaceMeterProps> = {
  args: { spentShare: 1.5, usualShare: 0.9, labelRight: "over the usual month" },
};
