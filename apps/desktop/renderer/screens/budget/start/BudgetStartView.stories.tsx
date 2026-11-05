import { BudgetStartView } from "./BudgetStartView.js";
import type { BudgetStartState } from "./useBudgetStart.js";

const noop = () => {};
const state = {
  title: "Home budget",
  tag: { tone: "warning", text: "0 of 3 steps" },
  mcpPrivacy: "strict",
  currency: "PLN",
  steps: [
    {
      key: "statement",
      status: "on",
      title: "First bank statement",
      tag: null,
      hint: "A CSV file (mBank, Pekao, Erste) or Open Banking.",
      actions: [{ label: "Import a statement", primary: true, onPress: noop }],
    },
  ],
  drawer: null,
  closeDrawer: noop,
} as unknown as BudgetStartState;

export default {
  title: "Budget/Start",
  component: BudgetStartView,
  args: { state, onGuide: noop, onAgentSettings: noop },
};
export const SetupRequired = {};
export const Loading = { args: { state: { ...state, steps: null } } };
