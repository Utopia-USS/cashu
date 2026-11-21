import { JournalView } from "./JournalView.js";

export default { title: "Signals/Journal", component: JournalView };

export const Ready = {
  args: {
    crumb: {
      label: "Breadcrumb",
      items: [{ label: "Investments", onPress() {} }, { label: "Decision journal" }],
    },
    title: "Decision journal",
    filter: { label: "Show", items: [["All", "all"]], value: "all", onChange() {} },
    instrument: {
      label: "Instrument",
      value: "",
      options: [{ value: "", label: "All instruments" }],
      onChange() {},
    },
    error: null,
    loading: false,
    record: {
      title: "Record",
      count: 1,
      empty: null,
      more: null,
      groups: [
        {
          key: "2026-11",
          label: "November",
          rows: [
            {
              key: "d:1",
              date: "5.11",
              dot: "nw",
              head: "Decision: held",
              main: [{ kind: "muted", key: "inst", text: "portfolio" }],
              tail: null,
            },
          ],
        },
      ],
    },
    stats: { title: "2026 in numbers", facts: [{ label: "Decisions", value: "1" }] },
    history: {
      title: "Signals history",
      count: null,
      empty: "No signals.",
      head: [],
      withAccount: false,
      rows: [],
    },
  },
};
export const Loading = { args: { ...Ready.args, loading: true } };
