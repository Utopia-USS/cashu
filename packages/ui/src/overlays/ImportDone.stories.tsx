import type { Meta, Story } from "../charts/testing/csf.js";
import { ImportDone, type ImportDoneProps } from "./ImportDrawer.js";

const meta = {
  title: "Overlays/ImportDone",
  component: ImportDone,
  args: { title: "Imported 12 transactions.", line: "Synthetic account" },
} satisfies Meta<ImportDoneProps>;
export default meta;
export const Default: Story<ImportDoneProps> = {};
