import type { Meta, Story } from "../charts/testing/csf.js";
import { BriefList } from "./MacroRows.js";

type Props = Parameters<typeof BriefList>[0];
const meta = {
  title: "Research/BriefList",
  component: BriefList,
  args: { label: "Supports", items: ["falling rates", "strong earnings"], tone: "sup" },
} satisfies Meta<Props>;
export default meta;
export const Supports: Story<Props> = {};
export const Risks: Story<Props> = {
  args: { label: "Watch", items: ["a strong dollar"], tone: "rsk" },
};
