import type { Meta, Story } from "../charts/testing/csf.js";
import { HealthPill, type HealthPillProps } from "./ResearchMarks.js";

const meta = {
  title: "Research/HealthPill",
  component: HealthPill,
  args: { label: "supports", tone: "sup", title: "thesis: supports" },
} satisfies Meta<HealthPillProps>;
export default meta;
export const Supports: Story<HealthPillProps> = {};
export const Invalidates: Story<HealthPillProps> = { args: { label: "invalidates", tone: "inv" } };
export const NoResearch: Story<HealthPillProps> = {
  args: { label: "no research", tone: "plain", dashed: true, muted: true },
};
export const Hollow: Story<HealthPillProps> = {
  args: { label: "weakens", tone: "weak", hollow: true },
};
