import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { MinimalOverviewView } from "./MinimalOverviewView.js";
import type { MinimalOverviewState } from "./useMinimalOverview.js";

/** Synthetic presentation fixture only: no vault, host or real amounts. */
const ready: MinimalOverviewState = {
  kind: "ready",
  heroLabel: "Portfolio · October",
  value: new Money(D("10450.25"), "PLN"),
  pnl: { amount: new Money(D("450.25"), "PLN"), ratio: D("0.045") },
  deposited: new Money(D("10000"), "PLN"),
  depositedDetail: "5 contributions of PLN 2,000",
  benchmark: D("0.031"),
  benchmarkDetail: "MSCI ACWI, same contributions",
  benchmarkTitle: null,
  due: "2026-10-10",
  nextDepositDetail: "PLN 2,000 · Synthetic broker · regular",
  holdings: "1 instrument · SYN",
  quiet: "no alerts · 2 signals",
  chart: {
    values: [2000, 2000, 2000, 2000, 2000, 0],
    labels: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
    kinds: ["main", "main", "main", "main", "main", "plan"],
    valueLabels: ["PLN 2,000", "PLN 2,000", "PLN 2,000", "PLN 2,000", "PLN 2,000", null],
    plan: 2000,
    planLabel: "plan PLN 2,000",
  },
  planCaption: "plan PLN 2,000 · by day 10",
  regularity: "5 of 5",
  previous: { label: "September contribution", detail: "PLN 2,000 · Sep 10" },
  current: {
    label: "Contribution PLN 2,000 by Oct 10",
    detail: "Synthetic broker · regular",
    done: false,
    canPlan: true,
  },
  plan: { amount: D("2000"), date: "2026-10-10", currency: "PLN", account: null },
  busy: false,
  error: null,
  onPlan: () => {},
  onAddAlert: () => {},
  onWatchInstrument: () => {},
};

export default {
  title: "Desktop/MinimalOverview",
  component: MinimalOverviewView,
  args: { state: ready },
};
export const Ready = {};
export const Planned = {
  args: {
    state: {
      ...ready,
      chart: { ...ready.chart, kinds: ready.chart.kinds.map(() => "main" as const) },
      current: { ...ready.current, detail: "planned Oct 10", done: true, canPlan: false },
    },
  },
};
export const FirstDeposit = {
  args: {
    state: {
      ...ready,
      value: new Money(D("0"), "PLN"),
      pnl: null,
      deposited: null,
      depositedDetail: null,
      benchmark: null,
      benchmarkDetail: "set it in the strategy",
      nextDepositDetail: null,
      holdings: null,
      quiet: "no alerts · no signals",
      chart: {
        values: [0, 0, 0, 0, 0, 0],
        labels: ready.chart.labels,
        kinds: ready.chart.kinds.map(() => "main" as const),
        valueLabels: ready.chart.labels.map(() => null),
        plan: null,
        planLabel: undefined,
      },
      planCaption: null,
      regularity: null,
      previous: null,
      current: {
        label: "Contribution  by Oct 10",
        detail: "as planned",
        done: false,
        canPlan: false,
      },
      plan: null,
    },
  },
};
export const Refused = {
  args: { state: { ...ready, error: "The contribution could not be planned." } },
};
export const Unavailable = { args: { state: { kind: "unavailable" } } };
export const Privacy = {
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider privacy>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
