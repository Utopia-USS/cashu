import type { Meta, Story } from "../charts/testing/csf.js";
import { Meter, type MeterProps } from "./Meter.js";

const meta = {
  title: "Native/Meter",
  component: Meter,
  args: { share: 0.62 },
} satisfies Meta<MeterProps>;
export default meta;
export const Default: Story<MeterProps> = {};
export const Thin: Story<MeterProps> = { args: { height: "thin", share: 0.3 } };
export const Accent: Story<MeterProps> = { args: { tone: "accent" } };
export const Warning: Story<MeterProps> = { args: { tone: "warning", share: 0.95 } };
export const Empty: Story<MeterProps> = { args: { share: 0 } };
export const Clamped: Story<MeterProps> = { args: { share: 1.4 } };
