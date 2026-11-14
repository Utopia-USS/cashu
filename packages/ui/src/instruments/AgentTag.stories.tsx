import type { Meta, Story } from "../charts/testing/csf.js";
import { AgentTag } from "./RowMarks.js";

const meta = {
  title: "Instruments/AgentTag",
  component: AgentTag,
  args: { text: "Added by the agent" },
} satisfies Meta<{ text: string }>;
export default meta;
export const Default: Story<{ text: string }> = {};
