import { FlowsView } from "./FlowsView.js";
import type { FlowsScreenState } from "./useFlowsScreen.js";

const noop = () => {};
const state = {
  bc: { currency: "PLN", codes: ["PLN"], base: "PLN", setCurrency: noop },
  month: null,
  onMonth: noop,
  today: "2026-11-05",
  title: "Cash flow (PLN)",
  gran: "monthly",
  granOptions: [{ value: "monthly", label: "monthly" }],
  onGran: noop,
  ranges: [
    ["12M", 12],
    ["Max", null],
  ],
  range: 12,
  onRange: noop,
  labels: ["2026-09", "2026-10"],
  bars: [
    { name: "Income", values: [5000, 5100], color: "positive" },
    { name: "Expenses", values: [3200, 3900], color: "negative" },
  ],
  line: { name: "Net", values: [1800, 1200], color: "net" },
  yFormat: (v: number) => String(v),
  tooltip: () => ({ title: "", rows: [] }),
  summary: "",
} as unknown as FlowsScreenState;

export default {
  title: "Budget/Flows",
  component: FlowsView,
  args: { state, monthClose: null, currencySwitch: null },
};
export const Ready = {};
export const Empty = { args: { state: { ...state, labels: [], bars: [] } } };
