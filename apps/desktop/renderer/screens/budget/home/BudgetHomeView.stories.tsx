import { BudgetHomeLoadingView, BudgetHomeView } from "./BudgetHomeView.js";
import type { BudgetHomeState } from "./budgetHomeState.js";
import { drill, otherSurplus, ready, slices } from "./budgetHomeStoryData.js";
import { OtherSurplusLink } from "./tileParts.js";

const links = otherSurplus.map((o) => <OtherSurplusLink key={o.currency} other={o} />);

const with_ = (patch: Partial<BudgetHomeState>) => ({
  args: { state: { ...ready, ...patch }, otherCurrencies: links },
});

export default {
  title: "Desktop/Budget/Home",
  component: BudgetHomeView,
  args: { state: ready, otherCurrencies: links },
};
/** A closed month in PLN with a little EUR and USD: the currency switch and "Also in ..." links. */
export const MultiCurrency = {};
/** One currency: no switch, no other currency's surplus. */
export const SingleCurrency = {
  args: {
    state: { ...ready, currency: { ...ready.currency, codes: ["PLN"] } },
    otherCurrencies: null,
  },
};
/** The month in progress: the tag, "so far", the light bars of the current month. */
export const IncompleteMonth = with_({
  period: { ...ready.period, label: "Nov 2026", inProgress: true, nextDisabled: true },
  hero: {
    ...ready.hero,
    value: "PLN 1,300.00",
    sub: { delta: null, positive: true, text: "so far" },
    chart: ready.hero.chart && {
      ...ready.hero.chart,
      groups: ready.hero.chart.groups.map((g, k) => ({ ...g, selected: k === 12 })),
    },
  },
});
/** A category opened: its row highlighted and the transactions tile under the donut. */
export const DrillOpen = with_({
  spending: { ...ready.spending, selected: "groceries" },
  drill,
});
/** A year: no "after the month" tile, the sub line counts the months. */
export const Year = with_({
  period: { ...ready.period, mode: "year", label: "2025" },
  hero: {
    ...ready.hero,
    sub: { delta: null, positive: true, text: "12 months · 4,912 PLN a month on average" },
  },
  afterMonth: null,
});
/** A shortfall: the label and the figure turn negative. */
export const Shortfall = with_({
  hero: { ...ready.hero, label: "Shortfall", value: "PLN -1,240.00", negative: true, sub: null },
});
const empty = with_({
  hero: { ...ready.hero, value: "PLN 0.00", chart: null, sub: null },
  spending: {
    ...ready.spending,
    slices: [],
    total: "0 PLN",
    empty: "No transactions in this period.",
  },
  subscriptions: {
    ...ready.subscriptions,
    count: null,
    monthly: null,
    sub: null,
    next: [],
    rest: [],
    ended: [],
    toggle: null,
    empty: "No subscriptions.",
  },
  uncategorized: null,
});
/** Nothing spent in the period, nothing to categorize, no subscriptions, no other currency. */
export const Empty = { args: { ...empty.args, otherCurrencies: null } };
/** Few categories (no folded rest). */
export const FewCategories = with_({
  spending: { ...ready.spending, slices: slices.slice(0, 3) },
});

export const Loading = { render: () => <BudgetHomeLoadingView /> };
