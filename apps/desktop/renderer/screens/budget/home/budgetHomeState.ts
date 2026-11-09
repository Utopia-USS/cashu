// What the merged budget screen's Views render (useBudgetHome builds it; stories fake it). Every text is
// formatted and privacy-masked already; numbers are only for geometry (bar heights, ring arcs).
import type { PeriodMode } from "./budgetHomeModel.js";

export interface PeriodBarState {
  mode: PeriodMode;
  setMode(mode: PeriodMode): void;
  /** "paź 2026", "Q4 2026", "2026", "Cały okres". */
  label: string;
  /** All: no stepper. */
  stepHidden: boolean;
  prevDisabled: boolean;
  nextDisabled: boolean;
  step(delta: -1 | 1): void;
  /** The period holds today: its figures are so far. */
  inProgress: boolean;
}

export interface CurrencyState {
  value: string;
  /** Currencies with data; the switch shows from two. */
  codes: readonly string[];
  set(currency: string): void;
}

interface MeterState {
  key: string;
  label: string;
  /** 0-100 of the track. */
  fill: number;
  tone: "positive" | "negative" | "muted";
  value: string;
}

export interface ChartGroupState {
  key: number;
  /** Axis label ("lis", "sty '26", "Q3", "2025"). */
  label: string;
  income: number;
  expense: number;
  selected: boolean;
  partial: boolean;
  tip: { title: string; rows: { name: string; value: string; negative?: boolean }[] };
}

export interface ChartState {
  /** Accessible name of the chart. */
  label: string;
  groups: readonly ChartGroupState[];
  /** Grid lines from 0 up, with their formatted labels. */
  ticks: readonly { value: number; label: string }[];
  /** The value at the top of the plot. */
  top: number;
  select(key: number): void;
}

export interface HeroState {
  /** "Nadwyżka" or "Niedobór". */
  label: string;
  /** The surplus with the currency code in front ("PLN 6 037,60"). */
  value: string;
  negative: boolean;
  /** Month: the difference to the average ("+1 099 zł" + "vs średnia z 12 mies."); else a plain line. */
  sub: { delta: string | null; positive: boolean; text: string } | null;
  meters: readonly MeterState[];
  chart: ChartState | null;
  legend: { income: string; spent: string };
}

/** "Też w EUR: +12,40 €": another currency's surplus in the same period; pressing switches to it. */
export interface OtherSurplusState {
  currency: string;
  lead: string;
  value: string;
  title: string;
  onPress(): void;
}

export interface SliceState {
  key: string;
  label: string;
  /** Arc size (one currency). */
  value: number;
  amount: string;
  /** "23%". */
  share: string;
  /** "23% wydatków" (the ring's tip). */
  shareText: string;
  /** A CSS colour (a palette token). */
  color: string;
  /** The row bar: 0-100 of the largest category. */
  fill: number;
  /** The collapsed "Reszta": its row opens these. */
  members?: readonly SliceState[];
}

export interface SpendingState {
  title: string;
  /** The total in the ring's centre. */
  total: string;
  slices: readonly SliceState[];
  /** The drilled category. */
  selected: string | null;
  select(key: string): void;
  /** The ring's accessible name. */
  label: string;
  /** No spending in the period. */
  empty: string | null;
}

interface DrillRowState {
  key: string;
  date: string;
  merchant: string;
  details: string | null;
  account: string;
  amount: string;
  negative: boolean;
  category: string;
}

export interface DrillState {
  key: string;
  label: string;
  color: string;
  /** "6 transakcji · paź 2026". */
  meta: string;
  sort: "date" | "amount";
  sortItems: readonly (readonly [string, "date" | "amount"])[];
  sortLabel: string;
  setSort(sort: "date" | "amount"): void;
  close(): void;
  closeLabel: string;
  rows: readonly DrillRowState[];
  /** "Pokaż wszystkie 23" / "Pokaż mniej"; null when everything shows. */
  more: { label: string; onPress(): void } | null;
  empty: string;
  categoryLabel: string;
  options: readonly { value: string; label: string; group?: string }[];
  busy: boolean;
  markCategory(txn: string, category: string): void;
}

export interface SubRowState {
  key: string;
  initial: string;
  payee: string;
  /** "co miesiąc", "co 14 dni", "ostatnio 3 lip". */
  cadence: string;
  amount: string;
  /** "jutro", "za 5 dni"; null for an ended one. */
  when: string | null;
  soon: boolean;
}

export interface SubscriptionsState {
  title: string;
  count: string | null;
  /** The monthly total in the primary currency and the small "/ mies." after it. */
  monthly: { value: string; unit: string } | null;
  /** Other currencies' monthly totals ("12,99 € / mies."). */
  extra: readonly string[];
  /** "5 276 zł rocznie · 4% wydatków". */
  sub: string | null;
  nextLabel: string;
  next: readonly SubRowState[];
  rest: readonly SubRowState[];
  endedLabel: string;
  ended: readonly SubRowState[];
  open: boolean;
  toggle: { label: string; onPress(): void } | null;
  empty: string | null;
}

export interface CushionFormState {
  draft: {
    enabled: boolean;
    mode: "amount" | "months";
    amount: string;
    months: string;
    currency: string;
    accountIds: readonly string[];
    monthlyMax: string;
  };
  set(patch: Partial<CushionFormState["draft"]>): void;
  currencies: readonly string[];
  accounts: readonly { id: string; name: string }[];
  /** Opened in incognito: the saved amounts are not in the fields (shown as dots); an empty one keeps them. */
  masked: boolean;
  error: string | null;
  busy: boolean;
  save(): Promise<void>;
  cancel(): void;
}

export interface AfterMonthState {
  title: string;
  /** The amount to invest, or null with the empty text. */
  amount: string | null;
  sub: string | null;
  empty: string | null;
  /** The contribution plan: its figure and whether the surplus covers it, or (value null) a quiet line saying
   * why there is no plan to compare with. */
  plan: {
    label: string;
    value: string | null;
    note: string;
    tone: "positive" | "warning" | "muted";
  } | null;
  cushion: {
    label: string;
    text: string;
    title: string | undefined;
    button: string;
    disabled: boolean;
    open: boolean;
    toggle(): void;
  };
  form: CushionFormState | null;
}

export interface UncategorizedState {
  title: string;
  summary: string;
  rows: readonly { key: string; name: string; count: string; total: string }[];
  review: { label: string; onPress(): void };
}

export interface BudgetHomeState {
  period: PeriodBarState;
  currency: CurrencyState;
  hero: HeroState;
  spending: SpendingState;
  drill: DrillState | null;
  subscriptions: SubscriptionsState;
  /** Month mode only. */
  afterMonth: AfterMonthState | null;
  /** Only with uncategorized merchants. */
  uncategorized: UncategorizedState | null;
}
