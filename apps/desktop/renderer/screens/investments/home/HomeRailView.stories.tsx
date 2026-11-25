import { AlertsBrief, CandidatesRail, HomeRailCard, SignalsBrief } from "./HomeRailView.js";

const row = { key: "acm", monogram: "ACM", title: "Synthetic Co", text: "6,0 % of the portfolio" };

const signals = {
  loading: false,
  groups: [
    { group: "risk", label: "New risks", rows: [row] },
    {
      group: "chance",
      label: "New opportunities",
      rows: [{ ...row, key: "pf", monogram: "Σ", portfolio: true }],
    },
    {
      group: "left",
      label: "Put off in the review",
      rows: [{ ...row, key: "x", note: "no decision" }],
    },
  ],
  empty: null,
  all: "All (8)",
  allDisabled: false,
  onAll() {},
} as const;
const alerts = {
  loading: false,
  counts: { close: "1 close", fired: "0 fired" },
  empty: null,
  rows: [
    { ...row, note: "0.7 pp to go", tag: "price", state: "near" as const, aria: "price, close" },
  ],
  all: "All (1)",
  onManage() {},
};
const candidate = {
  row: {
    ...row,
    text: "Q3 results on Nov 3; verified by research; outside your theme, a long note that wraps.",
  },
  noteId: 1,
  name: "Synthetic Co",
  whyOpen: false,
  watched: false,
  busy: false,
  why: ["✓ A synthetic criterion"],
  onWhy() {},
  onWatch() {},
  onDismiss() {},
};
const candidates = {
  loading: false,
  lead: "1 new candidate.",
  all: "All (4)",
  onAll() {},
  rows: [candidate, { ...candidate, noteId: 2, watched: true }],
};

export default { title: "Investments/HomeRail", component: HomeRailCard };

export const Rail = { args: { signals, alerts, candidates } };
export const Signals = { render: () => <SignalsBrief {...signals} /> };
export const SignalsEmpty = {
  render: () => <SignalsBrief {...signals} groups={[]} empty="Nothing new since the review." />,
};
export const Alerts = { render: () => <AlertsBrief {...alerts} /> };
export const AlertsEmpty = {
  render: () => (
    <AlertsBrief {...alerts} rows={[]} empty="Nothing close to its level. Watching 3 alerts." />
  ),
};
export const Candidates = {
  render: () => <CandidatesRail {...candidates} rows={[{ ...candidate, whyOpen: true }]} />,
};
