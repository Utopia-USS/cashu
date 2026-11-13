// Pure presentation variants of the Investments tab shell (review slot and top tabs), all invented.
// Store-backed integration lives in investments.native.test.tsx.
import { Text } from "react-native";
import { InvestmentsView } from "./InvestmentsView";
import type { InvestmentsViewProps } from "./investments-contracts";

const base: InvestmentsViewProps = {
  header: {
    profile: { initial: "A", name: "Anna" },
    fresh: { tone: "ok", text: "Prices from 07:31 · fetched by this phone" },
    offline: null,
    incognito: false,
    onProfilePress: () => {},
    onIncognitoToggle: () => {},
  },
  view: "portfolio",
  signalsCount: 1,
  review: {
    kind: "due",
    title: "Weekly review",
    meta: "Nov 9 - 15 · 6 cards · due Sunday",
    teaser:
      "A quiet week, ahead of the market, one decision waiting, one idea outside the portfolio.",
  },
  onViewChanged: () => {},
  onReviewPressed: () => {},
  onReviewUndo: () => {},
  children: <Text>Section</Text>,
};

const meta = { title: "Mobile/Investments", component: InvestmentsView, args: base };
export default meta;

export const DueReview = { args: base };
export const ReviewDone = {
  args: {
    ...base,
    signalsCount: 0,
    review: { kind: "done", sub: "Next one on Sun, Nov 22", canUndo: true },
  } satisfies InvestmentsViewProps,
};
export const ReviewWaitsOnMac = {
  args: {
    ...base,
    review: { kind: "done", sub: "2 cards wait on your Mac", canUndo: false },
  } satisfies InvestmentsViewProps,
};
export const NoStrategy = {
  args: {
    ...base,
    header: { ...base.header, fresh: { tone: "muted", text: "Prices not fetched yet" } },
    signalsCount: 0,
    review: null,
  } satisfies InvestmentsViewProps,
};
export const SignalsTab = { args: { ...base, view: "signals" } satisfies InvestmentsViewProps };
