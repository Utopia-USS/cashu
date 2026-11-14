// Pure presentation variants of the Net worth tab, all invented. Store-backed integration lives in
// moneyScreens.native.test.tsx.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import type { NetWorthViewProps } from "../money-contracts";
import { NetWorthView } from "./NetWorthView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const owner: NetWorthViewProps = {
  header: {
    profile: { initial: "A", name: "Anna" },
    fresh: { tone: "ok", text: "Bank data from 06:40" },
    offline: null,
    incognito: false,
    onProfilePress: () => {},
    onIncognitoToggle: () => {},
  },
  currency: "PLN",
  hero: {
    label: "converted",
    value: pln("97374.11"),
    change: { amount: pln("4120.00"), pct: D("0.0441"), sinceLabel: "since October" },
    parts: [{ currency: "EUR", amount: new Money(D("1240.00"), "EUR") }],
    rateDate: "Tue, Nov 10",
    otherCurrencies: [],
    missingRate: [],
  },
  chart: {
    label: "Net worth over 12 months",
    valueKind: "amount",
    yFormat: false,
    height: 80,
    series: [
      {
        name: "Value",
        area: true,
        values: [0.82, 0.85, 0.84, 0.88, 0.9, 0.89, 0.93, 0.95, 0.94, 0.97, 0.99, 1],
        accessibleSummary: "From 2025-11-30 PLN 79,800.00 to 2026-11-12 PLN 97,374.11",
      },
    ],
    xLabels: [
      { i: 0, text: "Nov 2025" },
      { i: 5, text: "May 2026" },
      { i: 11, text: "Nov 2026" },
    ],
  },
  facts: [
    { label: "Owned", value: pln("155374.11") },
    { label: "Owed", value: pln("0.00"), detail: "no loans" },
    { label: "Cash at hand", value: pln("39374.11"), detail: "3.5 months of spending" },
  ],
  accounts: [
    {
      gid: "a1",
      name: "Personal account",
      bank: "mBank",
      amount: pln("8212.40"),
      asOf: "2026-11-12",
      type: "checking",
    },
    {
      gid: "a2",
      name: "Savings",
      bank: "mBank",
      amount: pln("28400.00"),
      asOf: "2026-11-12",
      type: "savings",
    },
    {
      gid: "a3",
      name: "Euro account",
      bank: "Bank Pekao",
      amount: new Money(D("1240.00"), "EUR"),
      asOf: "2026-11-11",
      type: "checking",
    },
    {
      gid: "a4",
      name: "Cash wallet",
      bank: null,
      amount: pln("320.00"),
      asOf: "2026-11-08",
      type: "cash",
    },
  ],
  emptyCount: 1,
  showEmpty: false,
  loans: [],
  assets: [
    {
      gid: "s1",
      name: "Car",
      kind: "vehicle",
      amount: pln("58000.00"),
      asOf: "2026-11-12",
      stale: false,
      depreciationPerMonth: pln("580.00"),
    },
  ],
  partnerFirst: false,
  onLoanPressed: () => {},
  onShowEmptyToggled: () => {},
};

const partner: NetWorthViewProps = {
  ...owner,
  header: { ...owner.header, profile: { initial: "H", name: "Home" } },
  hero: {
    label: "net",
    value: pln("354980.20"),
    change: { amount: pln("2210.00"), pct: D("0.0063"), sinceLabel: "since October" },
    parts: [],
    rateDate: null,
    otherCurrencies: [],
    missingRate: [],
  },
  facts: [
    { label: "Owned", value: pln("744580.20") },
    { label: "Owed", value: pln("-389600.00") },
    { label: "Home equity", value: pln("330400.00") },
    { label: "Cash at hand", value: pln("24580.20"), detail: "2.9 months of spending" },
  ],
  accounts: [
    {
      gid: "h1",
      name: "Joint account",
      bank: "Erste Bank Polska",
      amount: pln("6180.20"),
      asOf: "2026-11-12",
      type: "checking",
    },
    {
      gid: "h2",
      name: "Joint savings",
      bank: "Bank Pekao",
      amount: pln("18400.00"),
      asOf: "2026-11-12",
      type: "savings",
    },
  ],
  emptyCount: 0,
  loans: [
    {
      gid: "l1",
      name: "Mortgage",
      outstanding: pln("-389600.00"),
      monthly: pln("2431.18"),
      payoffDate: "2049-03-15",
      share: 0.22,
    },
  ],
  assets: [
    {
      gid: "p1",
      name: "Flat",
      kind: "property",
      amount: pln("720000.00"),
      asOf: "2026-02-01",
      stale: false,
      depreciationPerMonth: null,
    },
  ],
  partnerFirst: true,
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/NetWorth", component: NetWorthView, args: owner };
export default meta;

export const Owner = { args: owner };
export const Partner = { args: partner };
export const NoRateYet = {
  args: {
    ...owner,
    hero: {
      ...owner.hero,
      label: "net",
      value: pln("96118.41"),
      parts: [],
      rateDate: null,
      otherCurrencies: [{ currency: "EUR", amount: new Money(D("1240.00"), "EUR") }],
      missingRate: ["EUR"],
    },
  } satisfies NetWorthViewProps,
};
export const EmptyShown = { args: { ...owner, showEmpty: true } satisfies NetWorthViewProps };
export const Empty = {
  args: {
    ...owner,
    hero: { ...partner.hero, value: null, change: null },
    chart: { ...owner.chart, series: [{ values: [] }], xLabels: [] },
    facts: [],
    accounts: [],
    emptyCount: 0,
    assets: [],
  } satisfies NetWorthViewProps,
};
export const Incognito = { args: owner, decorators: [privacy] };
