import type { Meta, Story } from "../charts/testing/csf.js";
import { PolarityText } from "./SignalGlyphs.js";

const meta = {
  title: "Instruments/PolarityText",
  component: PolarityText,
  args: { polarity: "positive" },
} satisfies Meta<{ polarity: string }>;
export default meta;
export const Default: Story<{ polarity: string }> = {};
