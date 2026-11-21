// Stories of the position page (CSF 3, invented figures): a held stock with a waiting alert, its thesis,
// research and decisions; the same once decided; a held ETF without a thesis or signals; hidden amounts;
// a watched instrument that is not held; an unknown one and one without a strategy yet.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import { PositionView, type PositionViewProps } from "./PositionView";

type Ready = Extract<PositionViewProps, { kind: "ready" }>;

const closes = [
  248.1, 251.3, 249.8, 244.2, 246.9, 250.4, 247.7, 243.1, 240.6, 238.2, 241.5, 236.9, 232.2, 227.7,
  223.3, 218.9, 214.6,
];

const stock: Ready = {
  kind: "ready",
  title: "Quux Games",
  hero: {
    ticker: "QUX",
    risk: true,
    name: "Quux Games",
    place: "Warsaw · Brokerage",
    share: "7.5% of the portfolio",
    value: new Money(D("9657.00"), "PLN"),
    result: D("-0.1259"),
    week: D("-0.094"),
    perUnit: "PLN 214.60 a share",
    fromHigh: "29% under the 52-week high",
  },
  chart: {
    label: "Price of Quux Games",
    valueKind: "share",
    yFormat: false,
    height: 110,
    series: [{ name: "Quux Games", area: true, values: closes }],
    levels: [
      { y: 205, kind: "alert", label: "alert · below PLN 205.00" },
      { y: 245.5, kind: "cost", muted: true, label: "avg. cost · PLN 245.50" },
      { y: 302.9, kind: "rule", muted: true, label: "52-wk high · PLN 302.94" },
    ],
    markers: [{ i: 3, kind: "buy" }],
    xLabels: [
      { i: 0, text: "Aug 12" },
      { i: closes.length - 1, text: "Nov 12" },
    ],
  },
  range: { value: "3m", onChange: () => {} },
  facts: { quantity: "45 units", averageCost: "PLN 245.50" },
  thesis: {
    why: "a full release pipeline through 2028 at a fair price",
    wrongIf: "the 2027 release slips again",
    sizePlan: "at most 8%, buy more only below PLN 205",
    exitPlan: null,
  },
  rows: [
    {
      kind: "signal",
      key: "s1",
      title: "Quux Games fell 9.4% in 5 sessions",
      sub: "Your alert · today",
      tag: { text: "open", tone: "negative" },
      onPress: () => {},
    },
    {
      kind: "note",
      key: "n1",
      title: "Q3 and the 2027 slate",
      sub: "Research note · Nov 7, 2026",
      tag: { text: "weakens", tone: "negative" },
      onPress: () => {},
    },
    {
      kind: "decision",
      key: "d1",
      title: "Nothing for now - “results first”",
      sub: "Aug 30, 2026",
    },
  ],
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/Investments/Position", component: PositionView, args: stock };
export default meta;

export const HeldWithAlert = { args: {} };

export const Decided = {
  args: {
    hero: { ...stock.hero, risk: false },
    rows: stock.rows.map((row) =>
      row.kind === "signal"
        ? { ...row, tag: { text: "noted", tone: "positive" }, onPress: null }
        : row,
    ),
  },
};

export const EtfWithoutThesis = {
  args: {
    title: "Synthetic All-World ETF",
    hero: {
      ...stock.hero,
      ticker: "SAWE",
      risk: false,
      name: "Synthetic All-World ETF",
      place: "Xetra · IKE",
      share: "40.6% of the portfolio",
      value: new Money(D("52068.66"), "PLN"),
      result: D("-0.1192"),
      week: D("0.008"),
      perUnit: "€141.20 a unit",
      fromHigh: "at the 52-week high",
    },
    thesis: null,
    rows: [],
  },
};

export const Incognito = {
  args: { facts: { quantity: "•••", averageCost: "•••" } },
  decorators: [privacy],
};

export const WatchedNotHeld = {
  args: {
    hero: {
      ...stock.hero,
      risk: false,
      place: "Warsaw",
      share: null,
      value: null,
      result: null,
      week: null,
    },
    facts: null,
    thesis: null,
    rows: [],
  },
};

export const Unknown = { args: { kind: "missing", reason: "unknown" } };
export const NoStrategyYet = { args: { kind: "missing", reason: "unavailable" } };
