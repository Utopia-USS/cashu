// Stories of the colour swatch: an allocation row key.
import { Swatch } from "./Swatch.js";
import type { Meta, Story } from "./testing/csf.js";
import type { SwatchProps } from "./types.js";

const meta = {
  title: "Charts/Swatch",
  component: Swatch,
  args: { color: "inv-global" },
} satisfies Meta<SwatchProps>;
export default meta;

export const AllocationRow: Story<SwatchProps> = {};
export const QuietRow: Story<SwatchProps> = { args: { size: "xs" } };
export const Dot: Story<SwatchProps> = { args: { size: "dot" } };
