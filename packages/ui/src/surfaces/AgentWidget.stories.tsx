import type { Meta, Story } from "../charts/testing/csf.js";
import { AgentWidget, type AgentWidgetProps } from "./AgentWidget.js";

const meta = {
  title: "Surfaces/AgentWidget",
  component: AgentWidget,
  args: { privacy: "strict", onSettings() {} },
} satisfies Meta<AgentWidgetProps>;
export default meta;
export const Default: Story<AgentWidgetProps> = {};
