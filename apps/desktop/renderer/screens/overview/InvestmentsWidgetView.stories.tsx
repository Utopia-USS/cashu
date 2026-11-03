import { D } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { InvestmentsWidgetView, type InvestmentsWidgetViewProps } from "./InvestmentsWidgetView.js";

const budget: InvestmentsWidgetViewProps["budget"] = {
  month: {
    label: "2026-09",
    complete: true,
    income: D("9000"),
    spending: D("4000"),
    surplus: D("5000"),
    suggestedTransfer: D("1500"),
    currency: "PLN",
    otherCurrencies: [],
  },
  norm: null,
  averageSavingsRate: null,
  subscriptions: { count: 0, monthlyTotal: D("0"), monthlyTotals: {} },
  subscriptionCurrency: "PLN",
  subscriptionNorm: null,
  dueThisWeek: [],
  dueCount: 0,
  staleCount: 0,
  strategyUnavailable: false,
};
const plan: InvestmentsWidgetViewProps["plan"] = {
  amount: "",
  date: "2026-10-01",
  error: null,
  busy: false,
  setAmount: () => {},
  setDate: () => {},
  start: () => {},
  submit: async () => {},
  remove: async () => {},
};
const ready: InvestmentsWidgetViewProps = {
  investment: {
    status: "available",
    value: D("12000"),
    currency: "PLN",
    positive: 2,
    risks: 1,
    alertsTriggered: 1,
    lastRun: { status: "ok", at: "2026-09-30T12:00:00+02:00" },
    ytd: 0.08,
    benchmarkYtd: 0.06,
    benchmarkStatus: "ok",
    yearPoints: [
      { date: "2026-07-31", value: 11000 },
      { date: "2026-08-31", value: 11500 },
      { date: "2026-09-30", value: 12000 },
    ],
    monthPlan: {
      monthlyAmount: D("1500"),
      remaining: D("1000"),
      covered: false,
      plannedCount: 1,
      currency: "PLN",
      dayOfMonth: 15,
    },
    openPlans: [],
  },
  budget,
  plan,
  today: "2026-10-01",
  privacy: false,
  lastRunDate: "30.09",
};

export default {
  title: "Desktop/Overview/Investments",
  component: InvestmentsWidgetView,
  args: ready,
};
export const Ready = {};
export const Unavailable = { args: { ...ready, investment: { status: "unavailable" as const } } };
export const ZeroStart = { args: { ...ready, investment: { ...ready.investment, value: D("0") } } };
export const Privacy = {
  args: { ...ready, privacy: true },
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider privacy>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
