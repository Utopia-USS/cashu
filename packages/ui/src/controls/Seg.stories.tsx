import type { Meta, Story } from "../charts/testing/csf.js";
import { Seg } from "./Seg.js";
import type { SegProps } from "./Seg.types.js";

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
export const Full: Story<SegProps<string>> = { args: { full: true } };
export const Disabled: Story<SegProps<string>> = {
  args: { disabled: true, title: "Read-only while syncing" },
};
