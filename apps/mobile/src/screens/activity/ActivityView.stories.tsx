// Stories of the Activity tab (CSF 3, invented payments): the owner's day list with the Cash button,
// a search answered by the payee summary, a search with no hits, an empty list, the partner's phone
// without a cash pool, and the list cut at its longest page.
import { D, Money } from "@cashu/domain";
import { ActivityView, type ActivityViewProps } from "./ActivityView";
import type { ActivityDay } from "./useActivityScreen";

const pln = (amount: string) => new Money(D(amount), "PLN");

const nov11: ActivityDay = {
  date: "2026-11-11",
  label: "Wed, Nov 11",
  spent: pln("403.93"),
  rows: [
    {
      gid: "t1",
      payee: "Biedronka",
      amount: pln("-86.40"),
      income: false,
      sub: { kind: "category", label: "Groceries", swatch: "palette-1", account: "Main account" },
      cash: false,
      dim: false,
    },
    {
      gid: "t2",
      payee: "Allegro",
      amount: pln("-317.53"),
      income: false,
      sub: { kind: "uncategorized" },
      cash: false,
      dim: false,
    },
    {
      gid: "t3",
      payee: "Savings",
      amount: pln("-500.00"),
      income: false,
      sub: { kind: "internal" },
      cash: false,
      dim: true,
    },
  ],
};

const nov10: ActivityDay = {
  date: "2026-11-10",
  label: "Tue, Nov 10",
  spent: pln("45.00"),
  rows: [
    {
      gid: "t4",
      payee: "Employer Ltd",
      amount: pln("8200.00"),
      income: true,
      sub: { kind: "category", label: "Salary", swatch: "palette-20", account: "Main account" },
      cash: false,
      dim: false,
    },
    {
      gid: "t5",
      payee: "Farmers market",
      amount: pln("-45.00"),
      income: false,
      sub: { kind: "category", label: "Groceries", swatch: "palette-1", account: "Cash" },
      cash: true,
      dim: false,
    },
  ],
};

const days = [nov11, nov10];

const base: ActivityViewProps = {
  header: {
    profile: { initial: "A", name: "Anna" },
    fresh: { tone: "ok", text: "Bank data from 06:40" },
    offline: null,
    incognito: false,
    onProfilePress: () => {},
    onIncognitoToggle: () => {},
  },
  canAddCash: true,
  showCash: true,
  onCashPressed: () => {},
  search: { value: "", onChange: () => {}, onClear: () => {} },
  filter: "all",
  chips: [
    { key: "all", label: "All", active: true },
    { key: "uncategorized", label: "To categorize", count: 3, active: false },
    { key: "income", label: "Income", active: false },
    { key: "cash", label: "Cash", active: false },
  ],
  onFilterPicked: () => {},
  account: {
    options: [
      { gid: "a1", name: "Main account" },
      { gid: "a2", name: "Cash" },
    ],
    selected: null,
    onPicked: () => {},
  },
  categoryFilter: null,
  mode: "browse",
  days,
  results: null,
  onEndReached: () => {},
  isLoadingMore: false,
  footer: null,
  onRowPressed: () => {},
  empty: null,
};

const meta = { title: "Mobile/Activity/Activity", component: ActivityView, args: base };
export default meta;

export const Browse = { args: {} };

export const CategoryFromSpending = {
  args: {
    categoryFilter: { key: "groceries", label: "Groceries", onClear: () => {} },
    days: [{ ...nov10, rows: nov10.rows.slice(1) }],
  },
};

export const SearchWithSummary = {
  args: {
    search: { value: "warta", onChange: () => {}, onClear: () => {} },
    mode: "search",
    results: {
      summary: {
        payee: "Warta",
        countLabel: "3 payments since 2024",
        rows: [
          {
            key: "w3",
            year: "2026",
            dateLabel: "Mar 14",
            amount: pln("-1284.00"),
            vsPrevious: "+7.9% vs the year before",
          },
          {
            key: "w2",
            year: "2025",
            dateLabel: "Mar 12",
            amount: pln("-1190.00"),
            vsPrevious: "+8.0% vs the year before",
          },
          {
            key: "w1",
            year: "2024",
            dateLabel: "Mar 15",
            amount: pln("-1101.85"),
            vsPrevious: null,
          },
        ],
      },
      countLabel: "3 payments",
    },
    days: [
      {
        date: "2026-03-14",
        label: "Sat, Mar 14",
        spent: null,
        rows: [
          {
            gid: "w3",
            payee: "Warta",
            amount: pln("-1284.00"),
            income: false,
            sub: { kind: "category", label: "Car", swatch: "palette-5", account: "Main account" },
            cash: false,
            dim: false,
          },
        ],
      },
      {
        date: "2025-03-12",
        label: "Wed, Mar 12, 2025",
        spent: null,
        rows: [
          {
            gid: "w2",
            payee: "Warta",
            amount: pln("-1190.00"),
            income: false,
            sub: { kind: "category", label: "Car", swatch: "palette-5", account: "Main account" },
            cash: false,
            dim: false,
          },
        ],
      },
    ],
  },
};

export const SearchNoMatch = {
  args: {
    search: { value: "zzz", onChange: () => {}, onClear: () => {} },
    mode: "search",
    results: { summary: null, countLabel: "0 payments" },
    days: [],
    empty: 'No payments match "zzz".',
  },
};

export const Empty = { args: { days: [], empty: "Nothing here." } };

export const PartnerWithoutCash = {
  args: {
    header: { ...base.header, profile: { initial: "H", name: "Home" } },
    showCash: false,
    chips: base.chips.filter((chip) => chip.key !== "cash"),
    account: { options: [{ gid: "a1", name: "Main account" }], selected: null, onPicked: () => {} },
    days: [{ ...nov11, rows: nov11.rows.slice(0, 2) }],
  },
};

export const LongestPage = { args: { footer: "Search to find older payments" } };

export const LoadingMore = { args: { isLoadingMore: true } };
