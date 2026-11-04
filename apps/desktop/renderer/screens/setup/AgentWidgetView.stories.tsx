import { AgentWidgetView } from "./AgentWidgetView.js";

const args = {
  agent: {
    kind: "ready" as const,
    cliPrefix: "cashu --profile synthetic",
    mcpAdd: "cashu mcp --profile synthetic",
    translocated: false,
  },
  skill: "/budget-setup",
  privacy: "strict",
  onCopy() {},
  onSettings() {},
};
export default { title: "Desktop/Setup/Agent", component: AgentWidgetView, args };
export const Ready = {};
export const Unavailable = {
  args: { ...args, agent: { kind: "unavailable", reason: "source_unbound" } },
};
