import type { Meta, Story } from "../charts/testing/csf.js";
import { type CardRow, CardRows } from "./HoverCard.js";

const rows: CardRow[] = [
  { key: "ISIN", value: "XX0000000000", tone: "tnum" },
  { key: "Gain", value: "+4.2 %", tone: "positive" },
];
const meta = {
  title: "Overlays/HoverCard rows",
  component: CardRows,
  args: { rows },
} satisfies Meta<{ rows: CardRow[]; alignEnd?: boolean }>;
export default meta;
export const Default: Story<{ rows: CardRow[]; alignEnd?: boolean }> = {};
