import type { Meta, Story } from "../charts/testing/csf.js";
import { ModuleStart, type ModuleStartProps } from "./ModuleStart.js";

const meta = {
  title: "Surfaces/ModuleStart",
  component: ModuleStart,
  args: {
    title: "Home budget",
    stepsTitle: "First steps",
    steps: [{ key: "statement", status: "on", title: "First bank statement" }],
  },
} satisfies Meta<ModuleStartProps>;
export default meta;
export const Default: Story<ModuleStartProps> = {};
export const Loading: Story<ModuleStartProps> = { args: { steps: null } };
