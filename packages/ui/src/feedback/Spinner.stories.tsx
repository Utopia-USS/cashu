import type { Meta, Story } from "../charts/testing/csf.js";
import { Spinner, type SpinnerProps } from "./Spinner.js";

const meta = {
  title: "Feedback/Spinner",
  component: Spinner,
  args: { label: "Loading" },
} satisfies Meta<SpinnerProps>;
export default meta;
export const Default: Story<SpinnerProps> = {};
export const Muted: Story<SpinnerProps> = { args: { className: "text-fg-muted text-xl" } };
