import type { Meta, Story } from "../charts/testing/csf.js";
import { SkeletonTable, type SkeletonTableProps } from "./SkeletonTable.js";

const meta = {
  title: "Feedback/SkeletonTable",
  component: SkeletonTable,
  args: { rows: 8 },
} satisfies Meta<SkeletonTableProps>;
export default meta;
export const Default: Story<SkeletonTableProps> = {};
