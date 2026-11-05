import type { Meta, Story } from "../charts/testing/csf.js";
import { Seg, type SegProps } from "./Seg.js";

const meta = {
  title: "Controls/Seg",
  component: Seg<string>,
  args: {
    label: "Range",
    items: [
      ["1M", "1m"],
      ["1Y", "1y"],
      ["Max", "max"],
    ],
    value: "1y",
    onChange: () => {},
  },
} satisfies Meta<SegProps<string>>;
export default meta;
export const Default: Story<SegProps<string>> = {};
export const Quiet: Story<SegProps<string>> = { args: { quiet: true } };
