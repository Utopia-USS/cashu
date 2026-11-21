import { SignalsDialogView } from "./SignalsDialogView.js";

const press = (label: string) => ({ label, onPress() {} });
const age = { text: "today", warn: false };

export default { title: "Signals/SignalsDialog", component: SignalsDialogView };

export const Ready = {
  args: {
    label: "Signals",
    title: "Signals",
    count: 1,
    decided: null,
    filter: { label: "Filter", items: [["All", "all"]], value: "all", onChange() {} },
    hint: "j / k: next · Enter: decision",
    empty: null,
    columns: [
      {
        label: "Portfolio",
        count: 1,
        none: "nothing",
        groups: [
          {
            kind: "single",
            key: "i:1",
            item: {
              id: 1,
              sub: false,
              quiet: false,
              cursor: true,
              flash: false,
              polarity: "negative",
              title: { kind: "plain", title: "Drawdown", sym: null, extra: null, age },
              metric: { kind: "fact", fact: { pre: "down", bold: "12 %", post: "" } },
              long: "down 12 %",
              age: null,
              thesis: null,
              actions: [press("Record a decision"), press("Acknowledge")],
              note: null,
              form: null,
            },
          },
        ],
      },
    ],
    foot: [{ text: "decisions", bold: "0 of 1", tail: " this week" }],
    journal: press("Decision journal"),
    onClose() {},
  },
};
export const Empty = {
  args: { ...Ready.args, count: null, empty: "No open signals.", columns: [] },
};
