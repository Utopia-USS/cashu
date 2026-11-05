// Przegląd (ab24ab6 core/Overview.tsx NetHero, core/overview/CoreWidgets.tsx, modules/loans/index.tsx
// LoansWidget): the formatting part, so the Views stay pure. Every amount goes through the old formatters, which
// mask the digits in privacy mode; names the native app hides in privacy mode stay hidden.
import { type core, D, type Decimal } from "@cashu/domain";
import { intlLocale } from "@cashu/i18n";
import { S as O } from "@cashu/i18n/core/Overview.strings";
import { S as C } from "@cashu/i18n/core/overview/CoreWidgets.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S as ST } from "@cashu/i18n/core/setupSteps.strings";
import { S as L } from "@cashu/i18n/loans/index.strings";
import type { BudgetWidgets, OverviewLoan } from "@cashu/store/overview";
import type { FactProps, MeterRow } from "@cashu/ui";
import {
  cur,
  cur0s,
  MONTH_GEN,
  MONTH_NOM,
  nAccounts,
  nModules,
  pctSigned,
  TYPE_LABEL,
} from "@cashu/ui-logic/core/format";
import { incomeShare, rateText } from "@cashu/ui-logic/loans/logic";

/** A run of text with an optional bold / tone (the old inline `<b>` / `.pos` / `.neg` / `.warn` spans). */
interface Run {
  text: string;
  bold?: boolean;
  tone?: "positive" | "negative" | "warning";
  title?: string;
}
export type Rich = readonly Run[];
export interface Link {
  label: string;
  onPress(): void;
}
/** A fact whose detail may carry toned runs (the investments hero fact). */
export interface RichFact extends Omit<FactProps, "detail"> {
  detail?: string | Rich | null;
}

const MASK = "•••";

/** The account row fields Konta reads (store overview `OverviewAccount`). */
interface OverviewAccount {
  readonly gid: string;
  readonly name: string;
  readonly bank: string;
  readonly type: string;
  readonly currency: string;
  readonly ibanTail: string | null;
  readonly amount: Decimal | null;
}
const f = (v: Decimal | null | undefined): number | null => (v == null ? null : v.toFloat());
const monthIndex = (iso: string) => Number(iso.slice(5, 7)) - 1;

/** Tooltip of a ratio over the norm. */
const normTitle = (n: { months: number }) => C.normTitle(n.months);

// ---- hero ---------------------------------------------------------------------------------------------------

export interface HeroModel {
  label: string;
  caption: string;
  value: string;
  delta: Rich | null;
  facts: RichFact[];
  other: string | null;
  meta: string | null;
}

export function heroModel(args: {
  facts: core.HeroFacts;
  change: { change: Decimal; changePct: Decimal | null; since: string } | null;
  norm: { expense: Decimal; months: number } | null;
  modules: number;
  investments: RichFact | null;
}): HeroModel {
  const { facts: h, change } = args;
  const c = h.currency;
  const whole = (v: number) => cur0s(v, c);
  const ch = f(change?.change);
  const delta: Rich | null =
    change === null || ch === null
      ? null
      : [
          {
            text: `${ch >= 0 ? "+" : ""}${whole(ch)}${change.changePct !== null ? ` (${pctSigned(change.changePct.toFloat())})` : ""}`,
            tone: ch >= 0 ? "positive" : "negative",
          },
          { text: ` ${O.since(MONTH_GEN[monthIndex(change.since)] ?? "")}` },
        ];
  const liabNames = h.liabilityTypes
    .map((t) => (TYPE_LABEL[t] ?? t).toLowerCase())
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 2)
    .join(", ");
  const liquid = h.liquid.toFloat();
  const spend = f(args.norm?.expense);
  const facts: RichFact[] = [
    {
      label: O.assets,
      value: whole(h.assets.toFloat()),
      detail: `${nAccounts(h.accounts)} · ${nModules(args.modules)}`,
    },
  ];
  if (h.liabilities.gt(D("0")))
    facts.push({
      label: O.liabilities,
      value: whole(-h.liabilities.toFloat()),
      detail: liabNames || null,
    });
  if (h.homeEquity !== null)
    facts.push({
      label: O.homeEquity,
      value: whole(h.homeEquity.toFloat()),
      detail: O.homeEquityDetail,
    });
  if (args.investments) facts.push(args.investments);
  facts.push({
    label: O.liquid,
    value: whole(liquid),
    ...(spend && args.norm ? { title: normTitle(args.norm) } : {}),
    detail: spend
      ? O.monthsOfSpending(
          (liquid / spend).toLocaleString(intlLocale(), {
            maximumFractionDigits: 1,
            minimumFractionDigits: 1,
          }),
        )
      : O.accountsAndCash,
  });
  const others = Object.entries(h.otherCurrencies);
  return {
    label: O.netWorth,
    caption: O.netWorth,
    value: cur(h.net.toFloat(), c),
    delta,
    facts,
    other: others.length
      ? O.otherCurrencies(others.map(([k, v]) => cur(v.toFloat(), k)).join(" · "))
      : null,
    meta: others.length ? O.notConverted : null,
  };
}

// ---- Budżet · <month> -------------------------------------------------------------------------------------

export interface BudgetMonthModel {
  title: string;
  tag: { text: string; tone: "positive" | "neutral" } | null;
  link: Link;
  rows: MeterRow[] | null;
  empty: string;
  foot: Rich[];
  others: string | null;
}

export function budgetMonthModel(b: BudgetWidgets, openExpenses: () => void): BudgetMonthModel {
  const m = b.month;
  const income = f(m?.income);
  const spending = f(m?.spending);
  const surplus = f(m?.surplus);
  const c = m?.currency ?? "PLN";
  const rate = income && surplus != null ? surplus / income : null;
  const avg = f(b.averageSavingsRate);
  const w = (v: number | null) =>
    income && v != null ? Math.max(0, Math.min(100, (Math.abs(v) / income) * 100)) : 0;
  const foot: Rich[] = [];
  if (rate != null)
    foot.push([{ text: C.savingsRate }, { text: C.percent(Math.round(rate * 100)), bold: true }]);
  if (avg != null)
    foot.push([{ text: C.avg6 }, { text: C.percent(Math.round(avg * 100)), bold: true }]);
  const sTone = (surplus ?? 0) >= 0 ? "positive" : "negative";
  return {
    title: C.budget(m ? (MONTH_NOM[monthIndex(m.label)] ?? "") : ""),
    tag:
      m === null || m.complete === null
        ? null
        : m.complete
          ? { text: C.closed, tone: "positive" }
          : { text: C.inProgress, tone: "neutral" },
    link: { label: C.expenses, onPress: openExpenses },
    rows:
      income == null
        ? null
        : [
            { key: "in", label: C.income, fill: 100, tone: "accent", value: cur0s(income, c) },
            { key: "out", label: C.expenses, fill: w(spending), value: cur0s(spending, c) },
            {
              key: "net",
              label: C.surplus,
              fill: w(surplus),
              tone: sTone,
              value: cur0s(surplus, c),
              valueTone: sTone,
            },
          ],
    empty: C.noLastMonth,
    foot,
    others: m?.otherCurrencies.length ? C.otherCurrencies(m.otherCurrencies.join(", ")) : null,
  };
}

// ---- Subskrypcje ---------------------------------------------------------------------------------------------

export interface SubscriptionsModel {
  title: string;
  count: number | null;
  link: Link;
  facts: FactProps[];
  warn: string | null;
}

export function subscriptionsModel(
  b: BudgetWidgets,
  privacy: boolean,
  open: () => void,
): SubscriptionsModel {
  const subs = b.subscriptions;
  const mc = b.subscriptionCurrency;
  const monthly = f(subs.monthlyTotals[mc] ?? null);
  const norm = b.subscriptionNorm;
  const exp = f(norm?.expense);
  const share = monthly != null && exp ? monthly / exp : null;
  const due = b.dueThisWeek;
  return {
    title: C.subscriptions,
    count: subs.count || null,
    link: { label: C.subscriptions, onPress: open },
    facts: [
      {
        label: C.monthly,
        value: monthly != null ? cur0s(monthly, mc) : "-",
        detail: share != null && norm ? C.ofSpending(pctSigned(share, false)) : null,
        ...(share != null && norm ? { title: normTitle(norm) } : {}),
      },
      {
        label: C.thisWeek,
        value: String(due.length),
        detail: due.length > 0 ? (privacy ? MASK : due.slice(0, 3).join(", ")) : null,
      },
    ],
    warn: b.staleCount ? C.noCharge(b.staleCount) : null,
  };
}

// ---- Konta ----------------------------------------------------------------------------------------------

const BANK: Record<string, string> = {
  mbank: "mBank",
  erste: "Erste",
  pekao: "Pekao",
  santander: "Erste",
};
const LISTED = new Set(["checking", "savings", "credit", "investment", "other"]);

export interface AccountsModel {
  title: string;
  count: number | null;
  toggle: Link | null;
  rows: {
    key: string;
    name: string;
    sub: string;
    value: string;
    negative: boolean;
    muted: boolean;
  }[];
  empty: string | null;
  wallet: Rich | null;
  cash: Link;
}

export function accountsModel(args: {
  accounts: readonly OverviewAccount[];
  wallet: { exists: boolean; balance: Decimal; currency: string };
  showEmpty: boolean;
  privacy: boolean;
  onToggle(): void;
  onCash(): void;
}): AccountsModel {
  const isEmpty = (a: OverviewAccount) => a.amount === null || a.amount.abs().lt(D("0.005"));
  const list = args.accounts
    .filter((a) => LISTED.has(a.type) && !(a.bank === "manual" && a.type === "other"))
    .sort((a, b) => (b.amount?.abs().toFloat() ?? 0) - (a.amount?.abs().toFloat() ?? 0));
  const empties = list.filter(isEmpty);
  const visible = args.showEmpty ? list : list.filter((a) => !isEmpty(a));
  const bank = (b: string) => (b === "manual" ? C.manual : (BANK[b] ?? b));
  return {
    title: C.accounts,
    count: list.length || null,
    toggle:
      empties.length > 0
        ? {
            label: args.showEmpty ? C.hideEmpty : C.showEmpty(empties.length),
            onPress: args.onToggle,
          }
        : null,
    rows: visible.map((a) => ({
      key: a.gid,
      name: args.privacy ? MASK : a.name,
      sub: args.privacy ? MASK : [bank(a.bank), a.ibanTail].filter(Boolean).join(" · "),
      value: cur(f(a.amount), a.currency),
      negative: (f(a.amount) ?? 0) < 0,
      muted: isEmpty(a),
    })),
    empty: list.length ? null : C.noBankAccounts,
    wallet: args.wallet.exists
      ? [
          { text: C.walletCash },
          { text: cur(args.wallet.balance.toFloat(), args.wallet.currency), bold: true },
        ]
      : null,
    cash: { label: args.wallet.exists ? C.addCashExpense : C.cash, onPress: args.onCash },
  };
}

// ---- a module that is not set up (PendingWidget) --------------------------------------------------------------

export interface PendingModel {
  id: string;
  title: string;
  tag: { text: string; tone: "positive" | "warning" };
  hide: Link;
  next: string;
  steps: string;
  cont: Link;
}

export function pendingModel(args: {
  id: string;
  name: string;
  state: string;
  steps: readonly { title: string; status: string; optional?: boolean }[] | null;
  onHide(): void;
  onContinue(): void;
}): PendingModel {
  const req = (args.steps ?? []).filter((s) => !s.optional);
  const done = req.filter((s) => s.status === "done").length;
  const n = req.length;
  const next = req.find((s) => s.status === "on") ?? req.find((s) => s.status !== "done") ?? null;
  const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  return {
    id: args.id,
    title: args.name,
    tag:
      args.state === "ready"
        ? { text: P.ready, tone: "positive" }
        : { text: args.steps && n ? ST.stepsOf(done, n) : P.notConfigured, tone: "warning" },
    hide: { label: C.hide, onPress: args.onHide },
    next: next ? C.nextStep(lower(next.title)) : C.waitsForData,
    steps: args.steps ? C.stepsDone(done, n) : "",
    cont: { label: C.continue, onPress: args.onContinue },
  };
}

// ---- Kredyty ---------------------------------------------------------------------------------------------

export interface LoansModel {
  title: string;
  count: number | null;
  link: Link;
  rows: { key: string; name: string; meta: string; value: string; sub: string | null }[];
  empty: string | null;
  foot: Rich | null;
}

export function loansModel(args: {
  loans: readonly OverviewLoan[];
  base: string;
  norm: { income: Decimal; months: number } | null;
  privacy: boolean;
  open(): void;
}): LoansModel {
  const perCur = new Map<string, number>();
  for (const l of args.loans)
    if (!l.monthlyPayment.isZero())
      perCur.set(l.currency, (perCur.get(l.currency) ?? 0) + l.monthlyPayment.toFloat());
  const share = incomeShare(perCur.get(args.base), f(args.norm?.income));
  const foot: Rich | null = perCur.size
    ? [
        { text: `${L.installments} ` },
        {
          text: [...perCur].map(([c, v]) => cur(v, c)).join(" · "),
          bold: true,
        },
        { text: L.perMonth },
        ...(share != null && args.norm
          ? [{ text: L.incomeShare(Math.round(share * 100)), title: normTitle(args.norm) }]
          : []),
      ]
    : null;
  return {
    title: L.title,
    count: args.loans.length || null,
    link: { label: L.title, onPress: args.open },
    rows: args.loans.map((l) => ({
      key: l.gid,
      name: args.privacy ? MASK : l.name,
      meta: [
        l.monthlyPayment.isZero()
          ? null
          : L.installment(cur(l.monthlyPayment.toFloat(), l.currency)),
        rateText(l.annualRate.toFloat()),
        l.payoffDate ? L.until(l.payoffDate.slice(0, 4)) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      value: cur(-l.outstanding.toFloat(), l.currency),
      sub:
        l.nextPrincipal === null
          ? null
          : `-${cur(l.nextPrincipal.toFloat(), l.currency)}${L.perMonth}`,
    })),
    empty: args.loans.length ? null : L.none,
    foot,
  };
}
