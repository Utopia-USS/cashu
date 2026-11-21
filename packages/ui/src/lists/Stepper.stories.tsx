import type { Meta, Story } from "../charts/testing/csf.js";
import { Stepper, type StepperProps } from "./Stepper.js";

const meta = {
  title: "Lists/Stepper",
  component: Stepper,
  args: { steps: ["Source", "File", "Review"], current: 1 },
} satisfies Meta<StepperProps>;
export default meta;
export const Default: Story<StepperProps> = {};
