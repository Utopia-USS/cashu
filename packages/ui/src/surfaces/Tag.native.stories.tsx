import type { Meta, Story } from "../charts/testing/csf.js";
import { Tag } from "./Tag.js";
import type { TagProps } from "./Tag.types.js";

const meta = {
  title: "Native/Tag",
  component: Tag,
  args: { children: "synced today" },
} satisfies Meta<TagProps>;
export default meta;
export const Neutral: Story<TagProps> = {};
export const Positive: Story<TagProps> = { args: { tone: "positive", children: "on track" } };
export const Warning: Story<TagProps> = { args: { tone: "warning", children: "3 to review" } };
export const Negative: Story<TagProps> = { args: { tone: "negative", children: "over budget" } };
export const Info: Story<TagProps> = { args: { tone: "info", children: "new" } };
export const Pressable: Story<TagProps> = {
  args: { tone: "warning", children: "3 to review", onPress: () => {} },
};
