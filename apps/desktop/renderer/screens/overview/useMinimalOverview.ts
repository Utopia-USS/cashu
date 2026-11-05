import { lang } from "@cashu/i18n";
import { investmentDesktopQueries } from "@cashu/store/investments/screen";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useNarrowFrame } from "../../shell/narrowFrame.js";
import { minimalOverviewModel } from "./minimalOverview.js";
import { usePlanActions } from "./useOverviewInvestments.js";

// Client descriptors carry ids/args only. The trusted host binds the real sources to these ids.
const portfolioQueries = investmentDesktopQueries();
const overview = overviewQueries({ prices: null });

/** The investments-only overview (ab24ab6 v2/Overview.tsx MinimalOverview): the portfolio over its whole history,
 * this month's open plans and the one-click plan of the month's contribution (the toast with its undo, old
 * usePlanActions). The page asks for the narrow frame (old `setNarrow(minimal)`). Navigation comes in from the
 * route. */
export function useMinimalOverview(args: {
  today: string;
  openNewAlert(): void;
  openWatchlist(): void;
}) {
  const { privacy } = useUiEnv();
  useNarrowFrame(true);
  const portfolio = useQuery(portfolioQueries.portfolio, {
    today: args.today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    account: null,
    range: "max",
  });
  const investment = useQuery(overview.investments, { today: args.today, lang: lang() });
  const actions = usePlanActions();
  if (portfolio.status !== "ready") return { kind: "unavailable" as const };
  const model = minimalOverviewModel({ portfolio, investment, today: args.today, privacy });
  const plan = model.plan;
  return {
    kind: "ready" as const,
    ...model,
    busy: actions.busy,
    onPlan: () => {
      if (plan !== null)
        void actions.save(plan.amount.toFloat(), plan.currency, plan.date, plan.account);
    },
    onAddAlert: args.openNewAlert,
    onWatchInstrument: args.openWatchlist,
  };
}

export type MinimalOverviewState = ReturnType<typeof useMinimalOverview>;
