import type { Meta, Story } from "../charts/testing/csf.js";
import { HintChip, type HintChipProps } from "./RowMarks.js";

const meta = {
  title: "Instruments/HintChip",
  component: HintChip,
  args: {
    code: "off-band",
    text: "off band",
    title: "Outside the strategy band",
    severity: "rule",
  },
} satisfies Meta<HintChipProps>;
export default meta;
export const Rule: Story<HintChipProps> = {};
export const Review: Story<HintChipProps> = { args: { severity: "review" } };
export const Info: Story<HintChipProps> = { args: { severity: "info" } };
