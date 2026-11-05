import { AlertsBrief, CandidatesRail, SignalsBrief } from "./HomeRailView.js";

const row = { key: "acm", monogram: "ACM", title: "Synthetic Co", text: "6,0 % of the portfolio" };

export default { title: "Investments/HomeRail", component: SignalsBrief };

export const Signals = {
  args: {
    loading: false,
    lead: "2 new items since the review.",
    groups: [
      {
        group: "risk",
        label: "Risks",
        rows: [row, { ...row, key: "pf", monogram: "Σ", portfolio: true }],
      },
    ],
    review: {
      name: "Weekly review",
      items: "2 items to decide",
      pills: [{ tone: "risk", text: "2 risks" }],
      onOpen() {},
    },
    unchanged: null,
    all: "All (2)",
    allDisabled: false,
    onAll() {},
  },
};

export const Alerts = {
  render: () => (
    <AlertsBrief
      loading={false}
      empty={null}
      rows={[{ ...row, tag: "price", state: "near", aria: "price, close" }]}
      all="All (1)"
      onManage={() => {}}
      onNew={() => {}}
    />
  ),
};

export const Candidates = {
  render: () => (
    <CandidatesRail
      loading={false}
      lead="1 new candidate."
      all={null}
      onAll={() => {}}
      rows={[
        {
          row,
          noteId: 1,
          name: "Synthetic Co",
          whyOpen: true,
          watched: false,
          busy: false,
          why: ["✓ A synthetic criterion"],
          onWhy() {},
          onWatch() {},
          onDismiss() {},
        },
      ]}
    />
  ),
};
