import type { Meta, Story } from "../charts/testing/csf.js";
import { SkeletonKpis, type SkeletonKpisProps } from "./SkeletonKpis.js";

const meta = {
  title: "Feedback/SkeletonKpis",
  component: SkeletonKpis,
  args: { n: 5 },
} satisfies Meta<SkeletonKpisProps>;
export default meta;
export const Default: Story<SkeletonKpisProps> = {};
