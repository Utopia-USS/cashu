// Przegląd (ab24ab6 core/Overview.tsx; layout design/desktop/overview/layered-tiles.html): the old `.wrap.wide`
// page with a toast stack, the first load as the Suspense fallback, then the bento: the net worth tile (with
// "Net worth over time" folded in) with budget and surplus beside it, then modules not set up, investments,
// assets and loans, then accounts and subscriptions. The investments reads mount only while that module is set up.

import { lang } from "@cashu/i18n";
import { S as D } from "@cashu/i18n/core/Overview.strings";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { Page, Skeleton, ToastProvider } from "@cashu/ui";
import { Suspense, useState } from "react";
import { S } from "../../Desktop.strings.js";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { AssetsWidgetView } from "./AssetsWidgetView.js";
import { CashDrawerView } from "./CashDrawerView.js";
import { InvestmentsSummaryWidgetView, SurplusWidgetView } from "./InvestmentsWidgetView.js";
import {
  investmentsHeroFact,
  investmentsSummaryModel,
  surplusApplies,
  surplusModel,
} from "./investmentsModel.js";
import { type OverviewTile, OverviewView } from "./OverviewView.js";
import {
  AccountsWidgetView,
  BudgetMonthWidgetView,
  LoansWidgetView,
  PendingWidgetView,
  SubscriptionsWidgetView,
} from "./OverviewWidgetsView.js";
import { useAssetDrawer } from "./useAssetDrawer.js";
import { useCashDrawer } from "./useCashDrawer.js";
import { type OverviewInvestments, useOverviewInvestments } from "./useOverviewInvestments.js";
import { type OverviewNavigation, useOverviewScreen } from "./useOverviewScreen.js";

const queries = overviewQueries({ prices: null });

export interface OverviewScreenProps {
  vault: string;
  nav: OverviewNavigation;
}

export function OverviewScreen(props: OverviewScreenProps) {
  return (
    <ToastProvider>
      <Page width="wide" label={S.overview}>
        <Suspense fallback={<OverviewLoading />}>
          <OverviewBound {...props} />
        </Suspense>
      </Page>
    </ToastProvider>
  );
}

/** First load: the net worth tile and the two tiles beside it as placeholders. */
function OverviewLoading() {
  return (
    <div role="status" className="grid grid-cols-12 gap-3.5">
      <div className="col-span-8 row-span-2 max-wide:col-span-12 max-wide:row-span-1">
        <Skeleton height={480} radius="widget" />
      </div>
      <div className="col-span-4 max-wide:col-span-6 max-narrow:col-span-12">
        <Skeleton height={233} radius="widget" />
      </div>
      <div className="col-span-4 max-wide:col-span-6 max-narrow:col-span-12">
        <Skeleton height={233} radius="widget" />
      </div>
    </div>
  );
}

function OverviewBound(props: OverviewScreenProps) {
  const modules = useQuery(queries.moduleStates);
  const investments = modules.some(
    (m) => m.id === "investments" && m.enabled && m.setupState !== "empty",
  );
  return investments ? <WithInvestments {...props} /> : <OverviewBody {...props} inv={null} />;
}

function WithInvestments(props: OverviewScreenProps) {
  const today = useCalendarDay();
  const widgets = useQuery(queries.investments, { today, lang: lang() });
  const inv = useOverviewInvestments({ today, widgets });
  return <OverviewBody {...props} inv={inv} />;
}

function OverviewBody({
  vault,
  nav,
  inv,
}: OverviewScreenProps & { inv: OverviewInvestments | null }) {
  const today = useCalendarDay();
  const cash = useCashDrawer();
  const s = useOverviewScreen({
    today,
    vault,
    nav,
    wallet: cash.wallet,
    onCash: () => cash.setOpen(true),
    investmentsFact: inv ? investmentsHeroFact(inv) : null,
  });
  const assets = useAssetDrawer(today, s.baseCurrency);
  const [other, setOther] = useState<string | null>(null);

  // The tiles in the bento's groups (OverviewView / overviewLayout.ts place them): beside the hero, the
  // middle row, the bottom row. Modules not set up come first in the middle row (old slots 35+).
  const side: OverviewTile[] = [];
  const middle: OverviewTile[] = [];
  const bottom: OverviewTile[] = [];
  if (s.show.budget) side.push({ id: "budget", node: <BudgetMonthWidgetView m={s.budget} /> });
  // Nadwyżka -> inwestycje only once there is a contribution plan (surplusApplies).
  if (inv && s.show.surplus && surplusApplies(inv, today))
    side.push({
      id: "investments.surplus",
      node: (
        <SurplusWidgetView
          m={surplusModel({
            inv,
            base: s.baseCurrency,
            today,
            other,
            setOther,
            openFlows: nav.openFlows,
          })}
        />
      ),
    });
  for (const m of s.pending)
    middle.push({ id: `pending.${m.id}`, node: <PendingWidgetView m={m} /> });
  if (inv && s.show.investments)
    middle.push({
      id: "investments.summary",
      node: (
        <InvestmentsSummaryWidgetView
          m={investmentsSummaryModel(inv, today, nav.openInvestments)}
        />
      ),
    });
  if (s.show.assets)
    middle.push({
      id: "assets.list",
      node: (
        <AssetsWidgetView
          state={assets}
          today={today}
          baseCurrency={s.baseCurrency}
          onSetup={() => nav.openSetup("assets")}
        />
      ),
    });
  if (s.show.loans) middle.push({ id: "loans.list", node: <LoansWidgetView m={s.loans} /> });
  bottom.push({ id: "accounts", node: <AccountsWidgetView m={s.accounts} /> });
  if (s.show.budget)
    bottom.push({ id: "subs", node: <SubscriptionsWidgetView m={s.subscriptions} /> });
  return (
    <>
      <OverviewView
        hero={s.hero}
        netWorth={s.netWorth}
        side={side}
        middle={middle}
        bottom={bottom}
        noModules={
          s.noModules ? { label: D.enableModules, onPress: nav.openModulesSettings } : null
        }
      />
      <CashDrawerView state={cash} />
    </>
  );
}
