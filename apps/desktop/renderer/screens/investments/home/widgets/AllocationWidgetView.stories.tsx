import { AllocationWidgetView } from "./AllocationWidgetView.js";
import type { AllocationWidgetProps } from "./allocationModel.js";

const args: AllocationWidgetProps = {
  title: "Allocation",
  wide: true,
  tag: { text: "2 out of band", tone: "warning", title: "band +-5 pp" },
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
      name: "Bucket",
      now: "Now / target",
      target: { text: "" },
      drift: { text: "Drift", title: "band +-5 pp" },
      value: "Value",
      toTarget: "To target",
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
    priority: {
      label: "Portfolio priority",
      text: "First grow the weight of bonds.",
      rowKey: "b",
      color: "inv-bonds",
    },
  },
  drawer: null,
};

export default {
  title: "Desktop/Investments/Home/AllocationWidget",
  component: AllocationWidgetView,
};
export const Buckets = { args };
export const InBand = {
  args: {
    ...args,
    tag: { text: "in band", tone: "positive", title: "band +-5 pp" },
    body: {
      ...args.body,
      rows: args.body.kind === "rows" ? args.body.rows.map((r) => ({ ...r, out: false })) : [],
    },
  },
};
export const Accounts = {
  args: {
    ...args,
    tag: null,
    view: "accounts",
    accounts: {
      warnings: { text: "warnings (1)", title: "1 stale price", onOpen() {} },
      add: { text: "+ Account", onPress() {} },
    },
    body: {
      kind: "accounts",
      donut: {
        label: "Accounts",
        segments: [
          { value: 8, color: "inv-global", name: "Broker A IKE" },
          { value: 2, color: "inv-pl", name: "Broker B" },
        ],
        center: { title: "10k", caption: "2 accounts" },
      },
      head: { name: "Account", now: "Now", value: "Value", snapshot: "Snapshot" },
      rows: [
        {
          key: 1,
          title: "",
          color: "inv-global",
          name: "Broker A IKE",
          share: "80.0%",
          value: "8,000",
          snapshot: "today",
          stale: false,
        },
        {
          key: 2,
          title: "",
          color: "inv-pl",
          name: "Broker B",
          share: "20.0%",
          value: "2,000",
          snapshot: "12.10",
          stale: true,
        },
      ],
    },
  },
};
export const Empty = {
  args: { ...args, tag: null, body: { kind: "empty", text: "No positions." } },
};
