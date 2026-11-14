import type { Meta, Story } from "../charts/testing/csf.js";
import { Hero, type HeroProps } from "./Hero.js";

const meta = {
  title: "Surfaces/Hero",
  component: Hero,
  args: {
    label: "Portfolio value",
    caption: "Portfolio value",
    value: "60 841.76",
    delta: "+255.51 (+0.4 %) this week",
    facts: [
      { label: "Year to date", value: "-1.3 %", detail: "MSCI ACWI -0.5 %" },
      { label: "Deposits", value: "25 000", detail: "plan 27 500" },
    ],
  },
} satisfies Meta<HeroProps>;
export default meta;
export const Default: Story<HeroProps> = {};
export const WithStatus: Story<HeroProps> = {
  args: { right: "Up to date", meta: "prices Fri 30.10" },
};
/** The investments home hero (design V5): no frame, quiet caption line with tags, the figure at statement size. */
export const Statement: Story<HeroProps> = {
  args: {
    variant: "statement",
    facts: [],
    meta: "prices Fri 30.10",
    right: "Weekly review",
  },
};
