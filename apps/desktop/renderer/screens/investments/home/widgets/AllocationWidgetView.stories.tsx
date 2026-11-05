import { AllocationWidgetView } from "./AllocationWidgetView.js";
import type { AllocationWidgetProps } from "./allocationModel.js";

const args: AllocationWidgetProps = {
  title: "Allocation",
  wide: true,
  tag: { text: "1 out of band", tone: "warning", title: "band +-5 pp" },
  viewLabel: "Allocation split",
  views: [
    ["Buckets", "buckets"],
    ["Classes", "classes"],
  ],
  view: "buckets",
  onView() {},
  accounts: null,
  body: {
    kind: "rows",
    donut: {
      label: "Allocation",
      segments: [
        { value: 70, color: "inv-global", name: "Global equities" },
        { value: 30, color: "inv-bonds", name: "Bonds" },
      ],
      center: { title: "10k", caption: "2 buckets" },
    },
    head: {
      name: "bucket",
      now: "now",
      target: { text: "target" },
      drift: { text: "drift" },
      value: "value",
      toTarget: "to target",
    },
    rows: [
      {
        key: "g",
        name: "Global equities",
        color: "inv-global",
        now: "70.0%",
        target: "60%",
        drift: "+10.0 pp",
        out: true,
        value: "7,000",
        toTarget: "-1,000",
      },
      {
        key: "b",
        name: "Bonds",
        color: "inv-bonds",
        now: "30.0%",
        target: "40%",
        drift: "-10.0 pp",
        out: true,
        value: "3,000",
        toTarget: "+1,000",
      },
    ],
    priority: { label: "Portfolio priority", text: "First grow the weight of bonds.", warn: true },
  },
  drawer: null,
};

export default {
  title: "Desktop/Investments/Home/AllocationWidget",
  component: AllocationWidgetView,
};
export const Buckets = { args };
export const Empty = {
  args: { ...args, tag: null, body: { kind: "empty", text: "No positions." } },
};
