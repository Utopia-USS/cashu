import type { Meta, Story } from "../charts/testing/csf.js";
import { RunError, type RunErrorProps } from "./RunError.js";

const meta = {
  title: "Feedback/RunError",
  component: RunError,
  args: { title: "Przekroczono limit czasu", source: "Synthetic fetch", details: "line 1\nline 2" },
} satisfies Meta<RunErrorProps>;
export default meta;
export const Default: Story<RunErrorProps> = {};
