import { lang } from "@cashu/i18n";
import { createPlannedDeposit } from "@cashu/store";
import { investmentDesktopQueries } from "@cashu/store/investments/screen";
import { overviewQueries } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { minimalOverviewModel } from "./minimalOverview.js";
import { W } from "./OverviewWidgets.strings.js";

// Client descriptors carry ids/args only. The trusted host binds the real sources to these ids.
const portfolioQueries = investmentDesktopQueries();
const overview = overviewQueries({ prices: null });

/** The investments-only overview: the portfolio over its whole history, this month's open plans and the
 * one-click plan of the month's contribution. Navigation comes in from the route. */
export function useMinimalOverview(args: {
  today: string;
  openNewAlert(): void;
  openWatchlist(): void;
}) {
  const { privacy } = useUiEnv();
  const portfolio = useQuery(portfolioQueries.portfolio, {
    today: args.today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    account: null,
    range: "max",
  });
  const investment = useQuery(overview.investments, { today: args.today, lang: lang() });
  const create = useCommand(createPlannedDeposit);
  const durable = useDurableCommands();
  const [error, setError] = useState<string | null>(null);
  if (portfolio.status !== "ready") return { kind: "unavailable" as const };
  const model = minimalOverviewModel({ portfolio, investment, today: args.today, privacy });
  const plan = async () => {
    if (model.plan === null) return;
    setError(null);
    try {
      const result = await durable.run("minimal-plan-create", create, {
        amount: model.plan.amount.format("f"),
        plannedDate: model.plan.date,
        currency: model.plan.currency,
        account: model.plan.account,
        note: null,
      });
      if (result.kind !== "completed") setError(commandFailure(result, W.planRefused));
    } catch {
      setError(W.planRefused);
    }
  };
  return {
    kind: "ready" as const,
    ...model,
    busy: create.isPending,
    error,
    onPlan: () => void plan(),
    onAddAlert: args.openNewAlert,
    onWatchInstrument: args.openWatchlist,
  };
}

export type MinimalOverviewState = ReturnType<typeof useMinimalOverview>;
