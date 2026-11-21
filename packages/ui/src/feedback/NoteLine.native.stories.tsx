import type { Meta, Story } from "../charts/testing/csf.js";
import { NoteLine, type NoteLineProps } from "./NoteLine.js";

const meta = {
  title: "Native/NoteLine",
  component: NoteLine,
  args: { icon: "laptop", children: "From your Mac, synced 2 h ago" },
} satisfies Meta<NoteLineProps>;
export default meta;
export const Default: Story<NoteLineProps> = {};
export const Long: Story<NoteLineProps> = {
  args: {
    icon: "doc",
    children: "Converted at the NBP mid rate of Nov 10; no rate, so left out: CHF",
  },
};
