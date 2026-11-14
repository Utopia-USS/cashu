import type { Meta, Story } from "../charts/testing/csf.js";
import { Skeleton, type SkeletonProps } from "./Skeleton.js";

const meta = {
  title: "Feedback/Skeleton",
  component: Skeleton,
  args: { height: 26, width: 320 },
} satisfies Meta<SkeletonProps>;
export default meta;
export const Default: Story<SkeletonProps> = {};
export const Widget: Story<SkeletonProps> = {
  args: { height: 92, width: "100%", radius: "widget" },
};
