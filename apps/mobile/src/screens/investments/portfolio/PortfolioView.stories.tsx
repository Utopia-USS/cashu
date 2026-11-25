// Pure presentation variants of the Investments tab's Portfolio view, all invented. Store-backed
// integration lives in investments.native.test.tsx.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import type { PortfolioViewProps } from "../investments-contracts";
import { PortfolioView } from "./PortfolioView";

const pln = (amount: string) => new Money(D(amount), "PLN");
const values = Array.from({ length: 52 }, (_, i) => 0.86 + 0.14 * Math.sin(i / 9) ** 2 + i / 600);

const ready: PortfolioViewProps = {
  status: "ready",
  accounts: {
    options: [
      { gid: "a1", name: "IKE" },
      { gid: "a2", name: "Brokerage" },
    ],
    selected: null,
    onPicked: () => {},
  },
  currency: "PLN",
  yearLabel: "2026",
  value: {
    total: pln("129825.00"),
    day: { amount: pln("-780.00"), pct: D("-0.006") },
    weekPct: D("-0.024"),
    incl: [new Money(D("12400.00"), "USD")],
    rateDate: "Tue, Nov 10",
  },
  chart: {
    label: "Portfolio value over 12 months",
    valueKind: "amount",
    yFormat: false,
    height: 74,
    series: [
      {
        name: "Value",
        area: true,
        values,
        accessibleSummary: "From 2025-11-13 PLN 112,000 to 2026-11-12 PLN 129,825",
      },
    ],
    xLabels: [
      { i: 0, text: "Nov 2025" },
      { i: 25, text: "May 2026" },
      { i: 51, text: "Nov 2026" },
    ],
  },
  facts: {
    thisYear: D("0.061"),
    fromHigh: D("-0.052"),
    unrealized: pln("14820.00"),
    added: pln("24000.00"),
    planToDate: pln("27500.00"),
  },
  allocation: {
    rows: [
      { key: "g", label: "Global equities", now: D("0.61"), target: D("0.6"), color: "inv-global" },
      { key: "p", label: "Gold", now: D("0.16"), target: D("0.15"), color: "inv-other" },
      { key: "b", label: "Bonds", now: D("0.17"), target: D("0.2"), color: "inv-bonds" },
      { key: "c", label: "Cash", now: D("0.06"), target: D("0.05"), color: "inv-cash" },
    ],
    drift: { label: "Bonds 3% below target", tone: "warn" },
  },
  positions: [
    {
      gid: "p1",
      name: "Vanguard FTSE All-World",
      ticker: "VWCE",
      value: new Money(D("12280.00"), "EUR"),
      weekPct: D("-0.012"),
      resultPct: D("0.142"),
      account: "IKE",
      risk: false,
    },
    {
      gid: "p2",
      name: "CD Projekt",
      ticker: "CDR",
      value: pln("9630.00"),
      weekPct: D("-0.094"),
      resultPct: D("-0.126"),
      account: "Brokerage",
      risk: true,
    },
    {
      gid: "p3",
      name: "Treasury bonds EDO",
      ticker: "EDO",
      value: pln("10000.00"),
      weekPct: null,
      resultPct: null,
      account: "Brokerage",
      risk: false,
    },
  ],
  pricesStale: 0,
  onPositionPressed: () => {},
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider
    locale="en-US"
    privacy
    bananas={{ anchor: "salary", perPln: 0.08, plnRates: { EUR: 4.3, USD: 3.7 } }}
  >
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/Investments/Portfolio", component: PortfolioView, args: ready };
export default meta;

export const Ready = { args: ready };
/** The owner's own strategy buckets: no targets, no drift, no allocation block (F7, as the desktop). */
export const OwnBuckets = {
  args: { ...ready, allocation: { rows: [], drift: null } } satisfies PortfolioViewProps,
};
export const StalePrices = { args: { ...ready, pricesStale: 2 } satisfies PortfolioViewProps };
export const EmptyPortfolio = {
  args: {
    ...ready,
    accounts: { ...ready.accounts, options: [] },
    value: { total: pln("0.00"), day: null, weekPct: null, incl: [], rateDate: null },
    chart: { ...ready.chart, series: [{ name: "Value", values: [] }], xLabels: [] },
    facts: {
      thisYear: null,
      fromHigh: null,
      unrealized: pln("0.00"),
      added: pln("0.00"),
      planToDate: null,
    },
    allocation: { rows: [], drift: null },
    positions: [],
  } satisfies PortfolioViewProps,
};
export const NoStrategy = {
  args: {
    status: "unavailable",
    message:
      "No strategy from your Mac yet. The portfolio is valued by it, so start with the strategy on your Mac.",
  } satisfies PortfolioViewProps,
};
export const Incognito = { args: ready, decorators: [privacy] };
