import { AgentWidgetView } from "./AgentWidgetView.js";

const args = {
  agent: {
    kind: "ready" as const,
    cliPrefix: "/synthetic/bin/cashu --profile synthetic",
    mcpAdd: "claude mcp add cashu-synthetic -- /synthetic/bin/cashu mcp --profile synthetic",
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
