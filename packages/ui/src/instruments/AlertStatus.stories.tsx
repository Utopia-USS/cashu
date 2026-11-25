import type { Meta, Story } from "../charts/testing/csf.js";
import { AlertStatus } from "./SignalGlyphs.js";

const meta = {
  title: "Instruments/AlertStatus",
  component: AlertStatus,
  args: { status: "triggered" },
} satisfies Meta<{ status: string }>;
export default meta;
export const Default: Story<{ status: string }> = {};
