import type { Meta, Story } from "../charts/testing/csf.js";
import { RelationIcon, type RelationIconProps } from "./ResearchMarks.js";

const meta = {
  title: "Research/RelationIcon",
  component: RelationIcon,
  args: { tone: "sup", glyph: "+", label: "supports the thesis" },
} satisfies Meta<RelationIconProps>;
export default meta;
export const Supports: Story<RelationIconProps> = {};
export const Invalidates: Story<RelationIconProps> = {
  args: { tone: "inv", glyph: "−", label: "invalidates the thesis" },
};
