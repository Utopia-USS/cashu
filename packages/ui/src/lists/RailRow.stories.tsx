import type { Meta, Story } from "../charts/testing/csf.js";
import { RailRow, type RailRowProps } from "./RailRow.js";

const meta = {
  title: "Lists/RailRow",
  component: RailRow,
  args: { row: { key: "a", monogram: "ACM", title: "ACM", text: "dropped 6 %", note: "today" } },
} satisfies Meta<RailRowProps>;
export default meta;
export const Default: Story<RailRowProps> = {};
export const Portfolio: Story<RailRowProps> = {
  args: { row: { key: "p", monogram: "Σ", portfolio: true, title: "Cash share" }, first: true },
};
