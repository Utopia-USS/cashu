import { ContributionsWidgetView } from "./ContributionsWidgetView.js";

/** Synthetic presentation fixture only: no vault, host or real amounts. */
export default {
  title: "Investments/ContributionsWidget",
  component: ContributionsWidgetView,
  args: {
    title: "Contributions",
    count: "12 months",
    body: {
      facts: [
        { label: "This year", value: "PLN 4,000", detail: "plan PLN 4,000" },
        { label: "Next", value: "10.11", detail: "PLN 2,000 per plan" },
      ],
      chart: {
        label: "Contributions over the last 12 months",
        height: 120,
        values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000, 0],
        labels: ["D", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N"],
        kinds: [
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "main",
          "plan",
        ],
        plan: 2000,
        planLabel: "plan PLN 2,000",
        valueKind: "amount",
      },
      empty: "No contributions.",
    },
  },
};
export const Ready = {};
export const Empty = {
  args: {
    body: {
      facts: [
        { label: "This year", value: "-", detail: "no plan in the strategy" },
        { label: "Next", value: "10.11" },
      ],
      chart: null,
      empty: "No contributions.",
    },
  },
};
export const Loading = { args: { body: null } };
