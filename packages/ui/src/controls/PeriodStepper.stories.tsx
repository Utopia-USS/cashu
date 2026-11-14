import type { Meta, Story } from "../charts/testing/csf.js";
import { PeriodStepper, type PeriodStepperProps } from "./PeriodStepper.js";

const meta = {
  title: "Controls/PeriodStepper",
  component: PeriodStepper,
  args: { label: "Nov 2026", onStep: () => {} },
} satisfies Meta<PeriodStepperProps>;
export default meta;
export const Default: Story<PeriodStepperProps> = {};
