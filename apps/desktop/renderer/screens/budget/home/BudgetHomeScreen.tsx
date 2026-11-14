// The budget tab (one screen for expenses, cash flow and subscriptions), mounted by the budget route. One
// Suspense boundary: the screen hook starts every query before reading any, so the screen reveals once; later
// period / currency / drill changes come as route transitions and keep the screen shown. Needs a ToastProvider
// above it; the remount per vault and privacy is the route's.
import { Suspense } from "react";
import { CategoriesDrawer } from "../expenses/CategoriesDrawer.js";
import { BudgetHomeLoadingView, BudgetHomeView } from "./BudgetHomeView.js";
import { OtherSurplusLink } from "./tileParts.js";
import { type BudgetHomeOptions, type OtherCurrencies, useBudgetHome } from "./useBudgetHome.js";
import { useOtherSurplus } from "./useOtherSurplus.js";

export type { BudgetHomeOptions } from "./useBudgetHome.js";

export function BudgetHomeScreen(props: BudgetHomeOptions) {
  return (
    <Suspense fallback={<BudgetHomeLoadingView />}>
      <BoundBudgetHome {...props} />
    </Suspense>
  );
}

function BoundBudgetHome(props: BudgetHomeOptions) {
  const { state, drawer, others } = useBudgetHome(props);
  return (
    <>
      <BudgetHomeView
        state={state}
        otherCurrencies={others.currencies.map((currency) => (
          <BoundOtherSurplus key={currency} currency={currency} others={others} />
        ))}
      />
      {drawer && <CategoriesDrawer currency={drawer.currency} onClose={drawer.onClose} />}
    </>
  );
}

/** One other currency's link: reads that currency's cash flow (started by the screen hook). */
function BoundOtherSurplus({ currency, others }: { currency: string; others: OtherCurrencies }) {
  const other = useOtherSurplus({ ...others, currency });
  return other && <OtherSurplusLink other={other} />;
}
