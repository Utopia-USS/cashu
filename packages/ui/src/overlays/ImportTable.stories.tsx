import type { Meta, Story } from "../charts/testing/csf.js";
import { ImportTable, type ImportTableProps } from "./ImportDrawer.js";

const meta = {
  title: "Overlays/ImportTable",
  component: ImportTable,
  args: {
    columns: [
      { key: "date", label: "Date" },
      { key: "amount", label: "Amount", num: true },
    ],
    empty: "The file contains no transactions.",
  },
} satisfies Meta<ImportTableProps>;
export default meta;
export const Empty: Story<ImportTableProps> = {};
