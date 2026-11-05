// The investments tab's Home (ab24ab6 v2/Home.tsx InvestmentsV2): the old `.wrap.wide` page box, a toast stack
// for the page and the deck, the first-load skeleton as the Suspense fallback, then the page from the screen hook
// with the widgets (widgets/), the rail, the research strip (research/) and the review deck (review/deck/); the
// research page (screens/research) in place of the grid and the topic drawer over it.

import { ToastProvider } from "@cashu/ui";
import { Suspense } from "react";
import { ResearchPageScreen } from "../../research/ResearchPageScreen.js";
import { TopicDrawerScreen } from "../../research/TopicDrawerScreen.js";
import { ReviewDeckScreen } from "../../review/deck/ReviewDeckScreen.js";
import { ReviewSlotView } from "../../review/deck/ReviewSlotView.js";
import { SignalsDialogScreen } from "../../signals/SignalsDialogScreen.js";
import { InstrumentSearchScreen } from "../../signals/WatchlistScreens.js";
import { AssetDrawerScreen, AssetPage } from "../asset/AssetDetailScreen.js";
import {
  AccountDrawer,
  ThesisDrawer,
  TxnDrawer,
  TxnsDrawer,
} from "../drawers/InvestmentDrawers.js";
import { AlertsBrief, CandidatesRail, SignalsBrief } from "./HomeRailView.js";
import { HomeErrorView, HomeLoadingView, HomePage, HomeView } from "./HomeView.js";
import { ImportDrawerView } from "./ImportDrawerView.js";
import { ResearchStripView } from "./research/ResearchStripView.js";
import { researchStripProps } from "./research/researchStripModel.js";
import { type ImportDrawerInput, useImportDrawer } from "./useImportDrawer.js";
import {
  type InvestmentsHomeOptions,
  useInvestmentsHomeScreen,
} from "./useInvestmentsHomeScreen.js";
import { AllocationWidgetView } from "./widgets/AllocationWidgetView.js";
import { AssetListView } from "./widgets/AssetListView.js";
import { allocationProps } from "./widgets/allocationModel.js";
import { assetListProps } from "./widgets/assetListModel.js";
import { ValueChartWidgetView } from "./widgets/ValueChartWidgetView.js";
import { valueChartProps } from "./widgets/valueChartModel.js";

export function InvestmentsHomeScreen(props: InvestmentsHomeOptions) {
  return (
    <ToastProvider>
      <HomePage narrow={!!props.page && !!props.instrument}>
        <Suspense fallback={<HomeLoadingView />}>
          <HomeBound {...props} />
        </Suspense>
      </HomePage>
    </ToastProvider>
  );
}

function ImportDrawer({ input }: { input: ImportDrawerInput }) {
  return <ImportDrawerView state={useImportDrawer(input)} />;
}

function HomeBound(props: InvestmentsHomeOptions) {
  const s = useInvestmentsHomeScreen(props);
  if (s.phase === "error" || !s.head) return <HomeErrorView message={s.error} />;
  const a = s.asset;
  const overlays = (
    <>
      {a && !a.page && (
        <AssetDrawerScreen
          instrument={a.instrument}
          filter={a.filter}
          noteGid={a.noteGid}
          onClose={a.onClose}
          onPage={a.onPage}
          onCrumb={a.onCrumb}
          {...a.actions}
        />
      )}
      {s.topicDrawer && <TopicDrawerScreen data={s.data} {...s.topicDrawer} />}
      {s.phase === "home" && s.signalsDialog && <SignalsDialogScreen {...s.signalsDialog} />}
      {s.importDrawer && <ImportDrawer input={s.importDrawer} />}
      {s.txnDrawer && <TxnDrawer {...s.txnDrawer} />}
      {s.accountDrawer && <AccountDrawer {...s.accountDrawer} />}
      {s.thesisDrawer && <ThesisDrawer {...s.thesisDrawer} />}
      {s.txnsDrawer && <TxnsDrawer {...s.txnsDrawer} />}
    </>
  );
  // `research`: the research page replaces the grid and keeps the Home's drawers (old Home.tsx:392).
  if (s.researchPage)
    return (
      <>
        <ResearchPageScreen data={s.data} {...s.researchPage} />
        {overlays}
      </>
    );
  // `assets/{id}?page=1`: the page replaces the grid and shares the Home's drawers (old Home.tsx:412-421).
  if (a?.page)
    return (
      <>
        <AssetPage
          instrument={a.instrument}
          filter={a.filter}
          noteGid={a.noteGid}
          onBack={a.onClose}
          onPanel={a.onPanel}
          {...a.actions}
        />
        {overlays}
      </>
    );
  const head = {
    head: s.head,
    onAccount: s.onAccount,
    onStale: s.onStale,
    onImport: s.onImport,
    onAddTxn: s.onAddTxn,
  };
  if (s.phase === "start" || !s.hero) {
    if (!s.start) return null;
    const start = s.start;
    return (
      <HomeView
        {...head}
        content={{
          kind: "start",
          start,
          onCopy: () => start.command && s.onCopy(start.command),
          onSettings: s.onSettings,
        }}
        overlays={overlays}
      />
    );
  }
  const strip = researchStripProps(s.data, s.research);
  return (
    <HomeView
      {...head}
      content={{
        kind: "home",
        hero: s.hero,
        reviewSlot: s.reviewSlot ? <ReviewSlotView slot={s.reviewSlot} /> : null,
        main: [
          {
            id: "value",
            node: (
              <ValueChartWidgetView
                {...valueChartProps(s.data, { ...s.widgets, range: s.range, onRange: s.onRange })}
              />
            ),
          },
          {
            id: "alloc",
            node: (
              <AllocationWidgetView
                {...allocationProps(s.data, {
                  ...s.widgets,
                  view: s.allocView,
                  onView: s.setAllocView,
                  filtered: s.filtered,
                  wide: true,
                  onAddAccount: s.onAddAccount,
                  onReconcile: s.onReconcile,
                  onSettings: s.onSettings,
                })}
              />
            ),
          },
          {
            id: "assets",
            node: (
              <AssetListView
                {...assetListProps(s.data, {
                  ...s.widgets,
                  tab: s.assetTab,
                  onTab: s.setAssetTab,
                  onOpenAsset: s.openPage,
                  onAddTxn: s.onAddTxn,
                  onUnwatch: s.unwatch.onUnwatch,
                  unwatchBusy: s.unwatch.unwatchBusy,
                })}
                search={
                  s.widgets.adding ? (
                    <InstrumentSearchScreen
                      onClose={() => s.widgets.onAdding(false)}
                      onOpen={s.openPage}
                    />
                  ) : null
                }
              />
            ),
          },
        ],
        rail: [
          { id: "signals", node: <SignalsBrief {...s.signals} /> },
          { id: "alerts", node: <AlertsBrief {...s.alerts} /> },
          ...(s.candidates
            ? [{ id: "candidates", node: <CandidatesRail {...s.candidates} /> }]
            : []),
        ],
        research: strip ? <ResearchStripView {...strip} /> : null,
      }}
      overlays={
        <>
          {s.deck && <ReviewDeckScreen {...s.deck} />}
          {overlays}
        </>
      }
    />
  );
}
