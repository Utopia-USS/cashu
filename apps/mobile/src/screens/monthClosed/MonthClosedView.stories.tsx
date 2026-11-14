// Pure presentation variants of the month-closed state, all invented. Store-backed integration lives in
// monthClosed.native.test.tsx.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import { MonthClosedView } from "./MonthClosedView";
import type { MonthClosedViewProps } from "./monthClosed-contracts";

const pln = (amount: string) => new Money(D(amount), "PLN");
const done = () => Promise.resolve();

const monthClosedOwner: MonthClosedViewProps = {
  chrome: {
    kind: "tab",
    header: {
      profile: { initial: "A", name: "Anna" },
      fresh: { tone: "ok", text: "Closed on Dec 1 06:40" },
      offline: null,
      incognito: false,
      onProfilePress: () => {},
      onIncognitoToggle: () => {},
    },
  },
  title: "November closed",
  hero: {
    label: "Kept in November",
    savingsRate: "savings rate 17%",
    surplus: pln("2560.00"),
    kpis: [
      { label: "Income", value: pln("14800.00") },
      { label: "Spent", value: pln("12240.00") },
      { label: "Cushion", value: "6.0 mo." },
    ],
  },
  strategy: {
    kind: "open",
    body: "The cushion is full, so the surplus can go to investing. Your monthly plan is PLN 2,500.",
    planLabel: "Plan PLN 2,500",
    canPlan: true,
    other: null,
    error: null,
    pending: false,
    onPlan: done,
    onOther: () => {},
    onAmountChange: () => {},
    onSave: done,
  },
  categories: {
    title: "Where November went",
    rows: [
      { key: "groceries", label: "Groceries", amount: pln("2890.00"), vsUsual: { kind: "usual" } },
      {
        key: "travel",
        label: "Travel",
        amount: pln("1286.00"),
        vsUsual: { kind: "over", text: "+114%" },
      },
      {
        key: "shopping",
        label: "Shopping",
        amount: pln("1720.00"),
        vsUsual: { kind: "over", text: "+41%" },
      },
      { key: "transport", label: "Transport", amount: pln("1310.00"), vsUsual: { kind: "usual" } },
      { key: "gifts", label: "Gifts", amount: pln("120.00"), vsUsual: null },
    ],
  },
  onShowRunning: () => {},
};

const monthClosedNoInvesting: MonthClosedViewProps = {
  ...monthClosedOwner,
  chrome: {
    kind: "tab",
    header: {
      profile: { initial: "H", name: "Home" },
      fresh: { tone: "ok", text: "Closed on Dec 1 06:40" },
      offline: null,
      incognito: false,
      onProfilePress: () => {},
      onIncognitoToggle: () => {},
    },
  },
  hero: {
    ...monthClosedOwner.hero,
    surplus: pln("910.00"),
    savingsRate: "savings rate 9%",
    kpis: [
      { label: "Income", value: pln("9600.00") },
      { label: "Spent", value: pln("8690.00") },
    ],
  },
  strategy: { kind: "off" },
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/MonthClosed", component: MonthClosedView, args: monthClosedOwner };
export default meta;

export const WithPlan = { args: monthClosedOwner };
/** Sync paused on Today's tab: the quiet line sits under the header, one line above the tiles. */
export const SyncPaused = {
  args: {
    ...monthClosedOwner,
    sync: {
      line: { text: "Sync paused since 19:40 · cashU works as usual", tone: "muted" },
      notice: null,
    },
  } satisfies MonthClosedViewProps,
};
export const Planned = {
  args: {
    ...monthClosedOwner,
    strategy: {
      kind: "planned",
      body: monthClosedOwner.strategy.kind === "open" ? monthClosedOwner.strategy.body : null,
      quote: "Planned PLN 2,500 for December.",
      error: null,
      pending: false,
      onUndo: done,
    },
  } satisfies MonthClosedViewProps,
};
export const OtherAmount = {
  args: {
    ...monthClosedOwner,
    strategy: {
      kind: "open",
      body: "The cushion is not full yet: PLN 400 of the surplus tops it up first. Your monthly plan is PLN 2,500.",
      planLabel: "Plan PLN 2,160",
      canPlan: true,
      other: { text: "0" },
      error: "Enter an amount above zero",
      pending: false,
      onPlan: done,
      onOther: () => {},
      onAmountChange: () => {},
      onSave: done,
    },
  } satisfies MonthClosedViewProps,
};
export const UndoRefused = {
  args: {
    ...monthClosedOwner,
    strategy: {
      kind: "planned",
      body: null,
      quote: "Planned PLN 2,500 for December.",
      error: "This deposit is already booked, so the plan stays.",
      pending: false,
      onUndo: done,
    },
  } satisfies MonthClosedViewProps,
};
export const WithoutInvesting = { args: monthClosedNoInvesting };
export const Pushed = {
  args: {
    ...monthClosedOwner,
    chrome: { kind: "pushed", fresh: { tone: "ok", text: "Closed on Dec 1 06:40" } },
    onShowRunning: null,
  } satisfies MonthClosedViewProps,
};
export const Incognito = { args: monthClosedOwner, decorators: [privacy] };
