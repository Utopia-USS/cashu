import type { Meta, Story } from "../charts/testing/csf.js";
import { MeterRows, type MeterRowsProps } from "./MeterRows.js";

const meta = {
  title: "Values/MeterRows",
  component: MeterRows,
  args: {
    rows: [
      { key: "in", label: "Przychody", fill: 100, tone: "accent", value: "11 800 zł" },
      { key: "out", label: "Wydatki", fill: 40, value: "4 786 zł" },
      {
        key: "net",
        label: "Nadwyżka",
        fill: 59,
        tone: "positive",
        value: "7 014 zł",
        valueTone: "positive",
      },
    ],
  },
} satisfies Meta<MeterRowsProps>;
export default meta;
export const Default: Story<MeterRowsProps> = {};
