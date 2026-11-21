import type { Meta, Story } from "../charts/testing/csf.js";
import { PolDot, type PolDotProps } from "./SignalGlyphs.js";

const meta = {
  title: "Instruments/PolDot",
  component: PolDot,
  args: { polarity: "negative", title: "Risk" },
} satisfies Meta<PolDotProps>;
export default meta;
export const Default: Story<PolDotProps> = {};
