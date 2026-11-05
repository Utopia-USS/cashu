import type { Meta, Story } from "../charts/testing/csf.js";
import { SetupSteps, type SetupStepsProps } from "./SetupSteps.js";

const meta = {
  title: "Lists/SetupSteps",
  component: SetupSteps,
  args: {
    steps: [
      { key: "a", title: "Import history", hint: "One file per account.", status: "done" },
      { key: "b", title: "Write a strategy", status: "on" },
      { key: "c", title: "Connect research", status: "todo", optional: true },
    ],
  },
} satisfies Meta<SetupStepsProps>;
export default meta;
export const Default: Story<SetupStepsProps> = {};
