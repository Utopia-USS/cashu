import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { BudgetView, type BudgetViewProps } from "./BudgetView.js";
import type { BudgetScreenState } from "./useBudgetScreen.js";
import { useCushionForm } from "./useCushionForm.js";

function Fixture(props: {
  tab?: BudgetScreenState["tab"];
  privacy?: boolean;
  empty?: boolean;
  drawer?: "categories" | "cushion" | "import";
}) {
  const form = useCushionForm("PLN", async () => {});
  const noop = () => {};
  const state: BudgetScreenState = {
    tab: props.tab ?? "expenses",
    privacy: props.privacy ?? false,
    today: "2026-10-20",
    currency: "PLN",
    codes: ["PLN", "EUR"],
    mode: "month",
    anchor: 24321,
    first: 24300,
    last: 24321,
    periodLabel: "2026-10",
    patch: noop,
    switchMode: noop,
    display: props.empty
      ? []
      : [{ category: "groceries", label: "Groceries", amount: D("123.45") }],
    small: [],
    collapsed: false,
    restOpen: false,
    selectSlice: noop,
    segments: props.empty ? [] : [{ name: "Groceries", value: 123.45, color: 1 }],
    total: new Money(D("123.45"), "PLN"),
    spending: [],
    drill: [],
    drillCategory: null,
    sort: "date",
    order: "desc",
    categories: [{ key: "groceries", label: "Groceries", kind: "expense" }],
    markCategory: async () => {},
    markMerchant: async () => {},
    offer: null,
    message: null,
    setMessage: noop,
    busy: false,
    categoriesOpen: props.drawer === "categories",
    categoryRows: [],
    saved: {},
    openCategories: noop,
    closeCategories: noop,
    subscriptions: props.empty
      ? []
      : [
          {
            counterparty: "Synthetic service",
            typicalAmount: D("12"),
            currency: "PLN",
            occurrences: 4,
            monthsCovered: 4,
            medianGapDays: 30,
            lastDate: "2026-10-01",
            active: true,
          },
        ],
    close: {
      month: "2026-09",
      complete: true,
      baseCurrency: "PLN",
      firstMonth: "2026-01",
      lastMonth: "2026-10",
      currencies: [],
      cushion: null,
      investing: null,
    },
    shiftClose: noop,
    strategyUnavailable: true,
    settingsUnavailable: false,
    form,
    cushionOpen: props.drawer === "cushion",
    openCushion: noop,
    closeCushion: noop,
    accounts: [],
    importOpen: props.drawer === "import",
    setImportOpen: noop,
    allCategories: false,
    setAllCategories: noop,
    gran: "monthly",
    ranges: [6, 12, 24, 0],
    range: 12,
    flowRows: props.empty
      ? []
      : [{ label: "2026-09", income: D("1000"), expense: D("100"), net: D("900") }],
    flowTip: () => ({ title: "2026-09", rows: [{ name: "Net", value: "900 PLN", amount: true }] }),
    flowSummary: "Synthetic cashflow",
  };
  const view: BudgetViewProps = {
    state,
    onTabPicked: noop,
  };
  return (
    <UiEnvProvider privacy={props.privacy ?? false} locale="en-US">
      <BudgetView {...view} />
    </UiEnvProvider>
  );
}
export default { title: "Desktop/Budget", component: BudgetView };
export const Spending = { render: () => <Fixture /> };
export const Flows = { render: () => <Fixture tab="flows" /> };
export const Subscriptions = { render: () => <Fixture tab="subs" /> };
export const Privacy = { render: () => <Fixture privacy /> };
export const Empty = { render: () => <Fixture empty /> };
export const Categories = { render: () => <Fixture drawer="categories" /> };
export const Cushion = { render: () => <Fixture drawer="cushion" /> };
export const ImportUnavailable = { render: () => <Fixture drawer="import" /> };
