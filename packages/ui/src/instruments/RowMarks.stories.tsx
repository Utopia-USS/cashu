import type { Meta, Story } from "../charts/testing/csf.js";
import { type MarksProps, RowMarks } from "./RowMarks.js";

const meta = {
  title: "Instruments/RowMarks",
  component: RowMarks,
  args: {
    flag: { state: "positive", label: "Chance" },
    alert: "Alert at 120",
    notes: "2 new notes",
  },
} satisfies Meta<MarksProps>;
export default meta;
export const Default: Story<MarksProps> = {};
export const FlagOnly: Story<MarksProps> = { args: { alert: null, notes: null } };
