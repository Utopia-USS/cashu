import type { Meta, Story } from "../charts/testing/csf.js";
import { ImportCounts, type ImportCountsProps } from "./ImportDrawer.js";

const meta = {
  title: "Overlays/ImportCounts",
  component: ImportCounts,
  args: {
    fresh: "12 new",
    duplicates: "3 duplicates",
    skipped: "1 skipped",
    filter: { label: "show only new", on: false, onChange: () => {} },
  },
} satisfies Meta<ImportCountsProps>;
export default meta;
export const Default: Story<ImportCountsProps> = {};
