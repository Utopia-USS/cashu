import { AssetsWidgetView } from "./AssetsWidgetView.js";
import assetStories from "./AssetsWidgetView.stories.js";
import { InvestmentsSummaryWidgetView, SurplusWidgetView } from "./InvestmentsWidgetView.js";
import { OverviewView, type OverviewViewProps } from "./OverviewView.js";
import {
  AccountsWidgetView,
  BudgetMonthWidgetView,
  LoansWidgetView,
  PendingWidgetView,
  SubscriptionsWidgetView,
} from "./OverviewWidgetsView.js";
import {
  accounts,
  budget,
  hero,
  investments,
  loans,
  netWorth,
  pending,
  privateHero,
  subscriptions,
  surplus,
} from "./overviewStoryData.js";

/** Every module on (the design's bento). */
const args: OverviewViewProps = {
  hero,
  netWorth,
  side: [
    { id: "budget", node: <BudgetMonthWidgetView m={budget} /> },
    { id: "investments.surplus", node: <SurplusWidgetView m={surplus} /> },
  ],
  middle: [
    { id: "investments.summary", node: <InvestmentsSummaryWidgetView m={investments} /> },
    { id: "assets.list", node: <AssetsWidgetView {...assetStories.args} /> },
    { id: "loans.list", node: <LoansWidgetView m={loans} /> },
  ],
  bottom: [
    { id: "accounts", node: <AccountsWidgetView m={accounts} /> },
    { id: "subs", node: <SubscriptionsWidgetView m={subscriptions} /> },
  ],
  noModules: null,
};

export default { title: "Desktop/Overview", component: OverviewView, args };
export const Ready = {};
/** Budget and investments only, loans not set up: the ghost tile joins the middle row. */
export const FewerModules = {
  args: {
    ...args,
    middle: [
      { id: "pending.loans", node: <PendingWidgetView m={pending} /> },
      { id: "investments.summary", node: <InvestmentsSummaryWidgetView m={investments} /> },
    ],
  },
};
/** No budget: the middle row moves up beside the net worth tile, accounts take the full width. */
export const NoBudget = {
  args: {
    ...args,
    side: [],
    bottom: [{ id: "accounts", node: <AccountsWidgetView m={accounts} /> }],
  },
};
export const Empty = {
  args: {
    ...args,
    side: [],
    middle: [],
    bottom: [{ id: "accounts", node: <AccountsWidgetView m={{ ...accounts, rows: [] }} /> }],
    noModules: { label: "Turn on modules", onPress: () => {} },
  },
};
export const Privacy = {
  args: {
    ...args,
    hero: privateHero,
    netWorth: { ...netWorth, chart: null, empty: null, foot: [] },
    side: [],
    middle: [],
    bottom: [],
  },
};
