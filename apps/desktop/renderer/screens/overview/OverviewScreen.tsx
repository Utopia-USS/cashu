// Przegląd (ab24ab6 core/Overview.tsx): the old `.wrap.wide` page with a toast stack, the first load as the
// Suspense fallback, then the hero and the widget grid in the old slot order: budget 10, surplus 20, investments
// 30, modules not set up 35+, net worth 40 (two columns), assets 45 and loans 50 (stacked beside it), accounts
// 70 (two columns), subscriptions 80. The investments reads mount only while that module is set up.

import { lang } from "@cashu/i18n";
import { S as D } from "@cashu/i18n/core/Overview.strings";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { type GridItem, Page, Skeleton, ToastProvider, useUiEnv } from "@cashu/ui";
import { Suspense, useEffect, useState } from "react";
import { S } from "../../Desktop.strings.js";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { AssetsWidgetView } from "./AssetsWidgetView.js";
import { CashDrawerView } from "./CashDrawerView.js";
import { InvestmentsSummaryWidgetView, SurplusWidgetView } from "./InvestmentsWidgetView.js";
import { investmentsHeroFact, investmentsSummaryModel, surplusModel } from "./investmentsModel.js";
import { OverviewView } from "./OverviewView.js";
import {
  AccountsWidgetView,
  BudgetMonthWidgetView,
  LoansWidgetView,
  NetWorthWidgetView,
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

/** First load: the hero and three widget placeholders. */
function OverviewLoading() {
  return (
    <div
      role="status"
      className="grid grid-cols-3 gap-4 max-wide:grid-cols-2 max-narrow:grid-cols-1"
    >
      <div className="col-span-3 max-wide:col-span-2 max-narrow:col-auto">
        <Skeleton height={92} radius="widget" />
      </div>
      <Skeleton height={160} radius="widget" />
      <Skeleton height={160} radius="widget" />
      <Skeleton height={160} radius="widget" />
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
  const { privacy } = useUiEnv();
  const widgets = useQuery(queries.investments, { today, lang: lang() });
  const inv = useOverviewInvestments({ today, privacy, widgets });
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
  // Privacy mode refuses asset edits: an open drawer closes (native behaviour).
  useEffect(() => {
    if (s.privacy && assets.open) assets.close();
  }, [s.privacy, assets]);

  type Slot = GridItem & { order: number };
  const slots: Slot[] = [];
  if (s.show.budget) {
    slots.push({ id: "budget", span: 1, order: 10, node: <BudgetMonthWidgetView m={s.budget} /> });
    slots.push({
      id: "subs",
      span: 1,
      order: 80,
      node: <SubscriptionsWidgetView m={s.subscriptions} />,
    });
  }
  if (inv && s.show.surplus)
    slots.push({
      id: "investments.surplus",
      span: 1,
      order: 20,
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
  if (inv && s.show.investments)
    slots.push({
      id: "investments.summary",
      span: 1,
      order: 30,
      node: (
        <InvestmentsSummaryWidgetView
          m={investmentsSummaryModel(inv, today, nav.openInvestments)}
        />
      ),
    });
  if (s.show.assets)
    slots.push({
      id: "assets.list",
      span: 1,
      order: 45,
      stack: "side",
      node: (
        <AssetsWidgetView
          state={assets}
          today={today}
          baseCurrency={s.baseCurrency}
          privacy={s.privacy}
          onSetup={() => nav.openSetup("assets")}
        />
      ),
    });
  if (s.show.loans)
    slots.push({
      id: "loans.list",
      span: 1,
      order: 50,
      stack: "side",
      node: <LoansWidgetView m={s.loans} />,
    });
  s.pending.forEach((m, k) => {
    slots.push({
      id: `pending.${m.id}`,
      span: 1,
      order: 35 + k / 10,
      node: <PendingWidgetView m={m} />,
    });
  });
  slots.push({ id: "networth", span: 2, order: 40, node: <NetWorthWidgetView m={s.netWorth} /> });
  slots.push({
    id: "accounts",
    span: 2,
    order: 70,
    node: <AccountsWidgetView m={s.accounts} />,
  });
  slots.sort((a, b) => a.order - b.order);
  return (
    <>
      <OverviewView
        hero={s.hero}
        slots={slots}
        noModules={
          s.noModules ? { label: D.enableModules, onPress: nav.openModulesSettings } : null
        }
      />
      <CashDrawerView state={cash} privacy={s.privacy} />
    </>
  );
}
