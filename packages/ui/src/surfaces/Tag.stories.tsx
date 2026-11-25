import type { Meta, Story } from "../charts/testing/csf.js";
import { Tag, type TagProps } from "./Tag.js";

const meta = {
  title: "Surfaces/Tag",
  component: Tag,
  args: { children: "prices Fri 30.10" },
} satisfies Meta<TagProps>;
export default meta;
export const Neutral: Story<TagProps> = {};
export const Warning: Story<TagProps> = { args: { tone: "warning", children: "3 off band" } };
export const Solid: Story<TagProps> = { args: { tone: "info", solid: true } };
