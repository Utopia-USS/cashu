import { HomeRailView, type HomeRailViewProps } from "./HomeRailView.js";

const args: HomeRailViewProps = {
  privacy: false,
  signals: {
    available: true,
    navigationAvailable: true,
    fresh: 1,
    left: 1,
    unchanged: 2,
    total: 5,
    reviewDue: true,
    nextReviewDay: "2026-11-08",
    rows: [
      {
        id: "synthetic-risk",
        tile: "ACM",
        title: "Synthetic risk",
        text: "A test thesis needs review.",
        group: "risk",
        onOpen() {},
      },
      {
        id: "synthetic-plan",
        tile: "Σ",
        title: "Synthetic plan",
        text: "An owner decision is pending.",
        note: "no decision",
        group: "plan",
        onOpen() {},
      },
    ],
    review: { name: "Weekly review", items: 2, counts: { risk: 1, plan: 1 }, onOpen() {} },
    onAll() {},
  },
  alerts: {
    available: true,
    active: 3,
    rows: [
      {
        id: "synthetic-alert-near",
        tile: "ACM",
        title: "Price threshold",
        note: "2% to go",
        tag: "price",
        state: "near",
      },
      {
        id: "synthetic-alert-met",
        tile: "XYZ",
        title: "Drawdown fired",
        note: "since 3 Nov",
        tag: "risk",
        state: "met",
      },
    ],
    onAll() {},
    onNew() {},
  },
};
export default { title: "Desktop/Investments/HomeRail", component: HomeRailView, args };
export const Due = {};
export const Quiet = {
  args: {
    ...args,
    signals: { ...args.signals, fresh: 0, left: 0, rows: [], review: null, reviewDue: false },
    alerts: { ...args.alerts, rows: [] },
  },
};
export const Unavailable = {
  args: {
    ...args,
    signals: { ...args.signals, available: false },
    alerts: { ...args.alerts, available: false },
  },
};
export const Privacy = { args: { ...args, privacy: true } };
