// The Subskrypcje tab (ab24ab6 modules/budget/Subscriptions.tsx): the native recurring payments as the old
// `/recurring` rows. The payee is hidden in privacy mode (native behaviour kept).
import { S } from "@cashu/i18n/budget/Subscriptions.strings";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { cur } from "@cashu/ui-logic/core/format";

const queries = budgetDesktopQueries();

export function useSubscriptionsScreen() {
  const { privacy } = useUiEnv();
  const items = useQuery(queries.subscriptions);
  return {
    rows: items.map((r) => ({
      key: `${r.counterparty}:${r.currency}:${r.typicalAmount.toString()}`,
      payee: privacy ? "•••" : r.counterparty,
      active: r.active,
      amount: cur(r.typicalAmount.toFloat(), r.currency),
      every: S.days(r.medianGapDays),
      last: r.lastDate,
    })),
  };
}
export type SubscriptionsScreenState = ReturnType<typeof useSubscriptionsScreen>;
