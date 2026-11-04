import { SetupView } from "./SetupView.js";
import type { SetupScreenState } from "./useSetupScreen.js";

const state = {
  kind: "ready",
  moduleId: "budget",
  name: "Budget",
  setupState: "partial",
  skill: "/budget-setup",
  steps: [
    {
      id: "statement",
      title: "Add a statement",
      description: "Synthetic setup step",
      status: "on",
      optional: false,
      actions: [
        {
          kind: "tab",
          label: "Expenses",
          target: "expenses",
          intent: {
            kind: "navigate",
            target: { kind: "module", module: "budget", tab: "expenses" },
          },
        },
      ],
    },
  ],
  done: 0,
  total: 1,
  agent: { kind: "unavailable", reason: "source_unbound" },
  mcpPrivacy: "strict",
  notice: null,
  onAction() {},
  onOpenModule() {},
  onAgentSettings() {},
} as unknown as SetupScreenState;
export default { title: "Desktop/Setup/Module", component: SetupView, args: { state } };
export const Partial = {};
export const Ready = { args: { state: { ...state, setupState: "ready", done: 1 } } };
export const Empty = { args: { state: { ...state, setupState: "empty", steps: [], total: 0 } } };
export const Disabled = { args: { state: { ...state, kind: "disabled" } } };
export const Unknown = { args: { state: { ...state, kind: "unknown" } } };
