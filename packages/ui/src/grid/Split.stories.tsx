import type { Meta, Story } from "../charts/testing/csf.js";
import { Split, type SplitProps } from "./Grid.js";

const meta = {
  title: "Layout/Split",
  component: Split,
  args: {
    main: [{ id: "value", node: "Value" }],
    rail: [{ id: "signals", node: "Signals" }],
  },
} satisfies Meta<SplitProps>;
export default meta;
export const Default: Story<SplitProps> = {};
