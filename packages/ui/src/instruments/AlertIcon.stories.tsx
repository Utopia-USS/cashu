import type { Meta, Story } from "../charts/testing/csf.js";
import { AlertIcon, type AlertIconProps } from "./SignalGlyphs.js";

const meta = {
  title: "Instruments/AlertIcon",
  component: AlertIcon,
  args: { state: "near" },
} satisfies Meta<AlertIconProps>;
export default meta;
export const Default: Story<AlertIconProps> = {};
