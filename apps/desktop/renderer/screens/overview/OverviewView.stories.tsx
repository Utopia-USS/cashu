import { OverviewView, type OverviewViewProps } from "./OverviewView.js";
import type { HeroModel } from "./overviewModel.js";

const hero: HeroModel = {
  label: "Net worth",
  caption: "Net worth",
  value: "12,000.00 PLN",
  delta: [{ text: "+50 PLN (+0.4%)", tone: "positive" }, { text: " since September" }],
  facts: [
    { label: "Assets", value: "14,000 PLN", detail: "3 accounts · 2 modules" },
    { label: "Liabilities", value: "-2,000 PLN", detail: "loan" },
    { label: "Liquid", value: "8,000 PLN", detail: "accounts and cash" },
  ],
  other: "other currencies: 400.00 EUR",
  meta: "not converted",
};
const args: OverviewViewProps = { hero, slots: [], noModules: null };

export default { title: "Desktop/Overview", component: OverviewView, args };
export const Ready = {};
export const Empty = {
  args: { ...args, noModules: { label: "Turn on modules", onPress: () => {} } },
};
export const Privacy = {
  args: {
    ...args,
    hero: {
      ...hero,
      value: "••• PLN",
      delta: null,
      facts: hero.facts.map((f) => ({ ...f, value: "••• PLN" })),
      other: null,
      meta: null,
    },
  },
};
