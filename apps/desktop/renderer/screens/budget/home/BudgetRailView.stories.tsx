import { AfterMonthTile, SubscriptionsTile, UncategorizedTile } from "./BudgetRailView.js";
import { afterMonth, subscriptions, uncategorized } from "./budgetHomeStoryData.js";

export default {
  title: "Desktop/Budget/Home rail",
  component: SubscriptionsTile,
  args: { subs: subscriptions },
};
/** The next four charges; the rest and the ended ones folded. */
export const Subscriptions = {};
/** Unfolded: the rest and the ended ones (dimmed). */
export const SubscriptionsOpen = {
  args: {
    subs: { ...subscriptions, open: true, toggle: { label: "Show fewer", onPress: () => {} } },
  },
};
/** Another currency's monthly total under the primary one. */
export const SubscriptionsTwoCurrencies = {
  args: { subs: { ...subscriptions, extra: ["21.74 EUR / month"] } },
};
/** After the month: the plan covered, the cushion off. */
export const AfterTheMonth = { render: () => <AfterMonthTile after={afterMonth} /> };
/** The plan short. */
export const AfterTheMonthShort = {
  render: () => (
    <AfterMonthTile
      after={{
        ...afterMonth,
        plan: {
          label: "Contribution plan",
          value: "4,000 PLN / mo",
          note: "1,200 PLN short",
          tone: "warning",
        },
      }}
    />
  ),
};
/** No strategy yet: the plan row only says so, quietly. */
export const AfterTheMonthNoStrategy = {
  render: () => (
    <AfterMonthTile
      after={{
        ...afterMonth,
        plan: { label: "Contribution plan", value: null, note: "no strategy", tone: "muted" },
      }}
    />
  ),
};
/** The cushion form open. */
export const CushionForm = {
  render: () => (
    <AfterMonthTile
      after={{
        ...afterMonth,
        cushion: { ...afterMonth.cushion, open: true, button: "Close" },
        form: {
          draft: {
            enabled: true,
            mode: "amount",
            amount: "10000",
            months: "6",
            currency: "PLN",
            accountIds: ["a1"],
            monthlyMax: "2000",
          },
          set: () => {},
          currencies: ["PLN", "EUR"],
          accounts: [
            { id: "a1", name: "Demo savings" },
            { id: "a2", name: "Demo joint" },
          ],
          error: null,
          busy: false,
          save: () => {},
          cancel: () => {},
        },
      }}
    />
  ),
};
/** Merchants without a category. */
export const NeedsACategory = { render: () => <UncategorizedTile uncat={uncategorized} /> };
