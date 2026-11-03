import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { OverviewView, type OverviewViewProps } from "./OverviewView.js";

const state: OverviewViewProps["state"] = {
  today: "2026-10-01",
  chartSummary: "Latest 12,000.00 PLN; low 11,000.00 PLN; high 12,000.00 PLN",
  chartTip: () => ({
    title: "Sep 30, 2026",
    rows: [{ name: "Net worth", value: "12,000.00 PLN", amount: true }],
  }),
  net: new Money(D("12000"), "PLN"),
  liquid: new Money(D("8000"), "PLN"),
  liabilities: new Money(D("2000"), "PLN"),
  homeEquity: null,
  otherCurrencies: [new Money(D("400"), "EUR")],
  change: new Money(D("50"), "PLN"),
  since: "2026-09-30",
  currency: "PLN",
  currencies: ["EUR", "PLN"],
  chart: [11000, 12000],
  points: [
    { date: "2026-08-31", value: new Money(D("11000"), "PLN") },
    { date: "2026-09-30", value: new Money(D("12000"), "PLN") },
  ],
  modules: [{ id: "budget", enabled: true, setupState: "ready" }],
};
export default {
  title: "Desktop/Overview",
  component: OverviewView,
  args: { state, canOpenLegacy: true, onCurrencyPicked: () => {}, onModuleOpened: () => {} },
};
export const Ready = {};
export const LegacyUnavailable = { args: { canOpenLegacy: false } };
export const Empty = { args: { state: { ...state, points: [], chart: [] } } };
export const Privacy = {
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider privacy>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
