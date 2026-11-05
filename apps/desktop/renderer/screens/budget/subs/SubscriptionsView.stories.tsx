import { SubscriptionsView } from "./SubscriptionsView.js";

const ready = {
  rows: [
    {
      key: "a",
      payee: "Synthetic streaming",
      active: true,
      amount: "49,99 zł",
      every: "30d",
      last: "2026-10-03",
    },
  ],
};

export default {
  title: "Budget/Subscriptions",
  component: SubscriptionsView,
  args: { state: ready },
};
export const Ready = {};
export const Empty = { args: { state: { rows: [] } } };
export const Privacy = {
  args: { state: { rows: ready.rows.map((r) => ({ ...r, payee: "•••" })) } },
};
