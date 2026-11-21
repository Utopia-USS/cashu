import { AlertRow } from "./AlertRowView.js";

export default { title: "Signals/AlertRow", component: AlertRow };

export const Waiting = {
  args: {
    trig: false,
    icon: { state: "near", title: "close to the level" },
    cond: "Synthetic below 100",
    agent: false,
    line: [
      { key: "now-label", text: "now ", bold: false },
      { key: "now", text: "104,00", bold: true },
    ],
    dist: { text: "4 % to 100,00", fill: 60 },
    status: null,
    remove: null,
  },
};
