import type { Meta, Story } from "../charts/testing/csf.js";
import { MacroMetrics } from "./MacroRows.js";

type Props = Parameters<typeof MacroMetrics>[0];
const meta = {
  title: "Research/MacroMetrics",
  component: MacroMetrics,
  args: {
    metrics: [
      { label: "VIX", text: "14.2" },
      { label: "10y yield", text: "4.1 %", stale: true, title: "data from 1.11" },
    ],
  },
} satisfies Meta<Props>;
export default meta;
export const Default: Story<Props> = {};
