// Kredyty (ab24ab6 modules/loans/Loans.tsx, Start.tsx, Drawers.tsx): the formatting part, so the Views stay pure.
// Amounts go through the old formatters (bananas or masked in incognito); loan names always show.
import { intlLocale, lang } from "@cashu/i18n";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S as N } from "@cashu/i18n/core/setupSteps.strings";
import { S as D } from "@cashu/i18n/loans/Drawers.strings";
import { S } from "@cashu/i18n/loans/Loans.strings";
import { S as T } from "@cashu/i18n/loans/Start.strings";
import type { LoanScreenRow } from "@cashu/store/loans/screen";
import type { ChartTip, KpiProps } from "@cashu/ui";
import { cur, cur0, dtFmt } from "@cashu/ui-logic/core/format";
import { capJoin, paymentHint, rateText } from "@cashu/ui-logic/loans/logic";
import { S as LG } from "@cashu/ui-logic/loans/logic.strings";
import { L } from "./Loans.strings.js";

const DAY = 86400000;

/** An example Polish transfer title (matching data, not UI copy): the phrase field's placeholder. */
export const PHRASE_EXAMPLE = "RATA KREDYTU";

/** Old api.ts `loanName`: the name, else "Kredyt n". */
export const loanName = (l: Pick<LoanScreenRow, "name">, i: number): string =>
  l.name || LG.loanN(i + 1);

/** "5.10" (English: "Oct 5") of "2026-10-05" (old Drawers.tsx `dmShort`). */
export const dmShort = (iso: string): string =>
  lang() === "pl"
    ? `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}`
    : new Intl.DateTimeFormat(intlLocale(), {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(
        Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))),
      );

/** One row of the loans table. */
export interface LoanListRow {
  key: string;
  name: string;
  installment: string;
  remaining: string;
  totalInterest: string;
  payoff: string;
}

export function listRows(rows: readonly LoanScreenRow[]): LoanListRow[] {
  return rows.map((l, k) => ({
    key: l.id,
    name: loanName(l, k),
    installment: cur(l.monthlyPayment.toFloat(), l.currency),
    remaining: cur(-l.outstanding.toFloat(), l.currency),
    totalInterest: cur(l.totalInterest.toFloat(), l.currency),
    payoff: l.payoffDate || "-",
  }));
}

/** The selected loan's detail: figures, balance chart and schedule (old `LoanDetail`). */
export interface LoanDetailModel {
  kpis: KpiProps[];
  chart: {
    title: string;
    labels: string[];
    xs: number[];
    values: number[];
    span: number;
    yFormat(v: number): string;
    tooltip(i: number): ChartTip;
    summary: string;
  };
  schedule: {
    n: number;
    date: string;
    payment: string;
    interest: string;
    principal: string;
    balance: string;
  }[];
}

const xTickFmt = () => new Intl.DateTimeFormat(intlLocale(), { month: "short", year: "2-digit" });
export const xTick = (ms: number): string => xTickFmt().format(new Date(ms));

export function loanDetail(loan: LoanScreenRow, name: string): LoanDetailModel {
  const c = loan.currency;
  const rows = loan.summary.schedule;
  const xs = rows.map((r) => new Date(r.date).getTime());
  const values = rows.map((r) => r.balance.toFloat());
  const first = xs[0] ?? 0;
  const last = xs.at(-1) ?? 0;
  const lastValue = values.at(-1);
  return {
    kpis: [
      { label: S.monthlyInstallment, value: cur(loan.monthlyPayment.toFloat(), c) },
      { label: S.remaining, value: cur(loan.outstanding.toFloat(), c), tone: "negative" },
      { label: S.totalInterest, value: cur(loan.totalInterest.toFloat(), c) },
      { label: S.paidInterest, value: cur(loan.paidInterest.toFloat(), c) },
      {
        label: S.payoffDate,
        value: loan.payoffDate || "-",
        hint: S.paidCount(loan.monthsElapsed),
      },
    ],
    chart: {
      title: S.balanceOf(name),
      labels: rows.map((r) => r.date),
      xs,
      values,
      span: xs.length >= 2 ? (last - first) / DAY : 0,
      yFormat: (v) => cur0(v, c),
      tooltip: (i) => ({
        title: dtFmt.format(new Date(xs[i] ?? first)),
        rows: [{ name: S.balance, value: cur(values[i] ?? 0, c), amount: true }],
      }),
      summary:
        lastValue === undefined
          ? S.noSchedule
          : L.chartSummary(
              cur(lastValue, c),
              cur(Math.min(...values), c),
              cur(Math.max(...values), c),
            ),
    },
    schedule: rows.map((s) => ({
      n: s.n,
      date: s.date,
      payment: cur(s.payment.toFloat(), c),
      interest: cur(s.interest.toFloat(), c),
      principal: cur(s.principal.toFloat(), c),
      balance: cur(s.balance.toFloat(), c),
    })),
  };
}

/** The balance chart's range switch: [label, days] (null = Max). */
export const chartRanges = (): (readonly [string, number | null])[] => [
  [S.oneYear, 365],
  [S.years(5), 1825],
  [S.years(10), 3650],
  [S.max, null],
];

// ---- first steps (old Start.tsx) ----------------------------------------------------------------------------

export interface SetupStepInfo {
  id: string;
  status: "done" | "on" | "todo";
  optional?: boolean;
}

/** Old SetupPage `stepsTag`: ready, else the required steps done, else not set up. */
export function stepsTag(info: { state: string; steps: readonly SetupStepInfo[] } | null): {
  tone: "positive" | "warning";
  text: string;
} {
  if (info?.state === "ready") return { tone: "positive", text: P.ready };
  const required = info?.steps.filter((s) => !s.optional) ?? [];
  if (!info || !required.length) return { tone: "warning", text: P.notConfigured };
  return {
    tone: "warning",
    text: N.stepsOf(required.filter((s) => s.status === "done").length, required.length),
  };
}

export interface StartStep {
  key: string;
  status: "done" | "on" | "todo";
  title: string;
  tag: string | null;
  hint: string;
  actions: { label: string; primary: boolean; onPress(): void }[];
}

export function startSteps(args: {
  steps: readonly SetupStepInfo[] | null;
  budgetOn: boolean;
  loans: readonly LoanScreenRow[];
  base: string;
  openLoan(): void;
  openPayment(account: string | null): void;
}): StartStep[] | null {
  const { steps, loans } = args;
  if (!steps) return null;
  const loanStep = steps.find((s) => s.id === "loan") ?? null;
  const payStep = args.budgetOn ? (steps.find((s) => s.id === "payments") ?? null) : null;
  const loanLine = (l: LoanScreenRow, i: number) => {
    const c = l.currency || args.base;
    return [
      loanName(l, i),
      rateText(l.annualRate.toFloat()),
      T.installment(cur(l.monthlyPayment.toFloat(), c)),
      l.payoffDate ? T.until(l.payoffDate.slice(0, 4)) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const loanDone = loanStep?.status === "done" && loans.length > 0;
  const payDone = payStep?.status === "done";
  const firstOpen =
    loans.find((l) => !l.paymentText && !l.paymentIbanTail)?.accountId ??
    loans[0]?.accountId ??
    null;
  const out: StartStep[] = [
    {
      key: "loan",
      status: loanStep?.status ?? "on",
      title: T.loan,
      tag: loanDone ? T.nLoans(loans.length) : null,
      hint: loanDone ? capJoin(loans.map(loanLine)) : T.loanHint,
      actions: [
        loanStep?.status === "done"
          ? { label: T.addAnother, primary: false, onPress: args.openLoan }
          : { label: T.addLoan, primary: true, onPress: args.openLoan },
      ],
    },
  ];
  if (payStep)
    out.push({
      key: "payments",
      status: payStep.status,
      title: T.payments,
      tag: null,
      hint:
        payDone && loans.length
          ? capJoin(
              loans.map((l, i) => {
                const h = paymentHint(
                  { payment_text: l.paymentText, payment_iban_tail: l.paymentIbanTail },
                  true,
                );
                return h ? `${loanName(l, i)} · ${h}` : loanName(l, i);
              }),
            )
          : T.paymentsHint,
      actions:
        payStep.status === "todo" || !loans.length
          ? []
          : [
              payDone
                ? { label: T.change, primary: false, onPress: () => args.openPayment(firstOpen) }
                : { label: T.pick, primary: true, onPress: () => args.openPayment(firstOpen) },
            ],
    });
  return out;
}

/** The loan form's footer preview (old `preview`), "" while the figures are incomplete. */
export function previewText(
  amount: number | null,
  months: number | null,
  currency: string,
): string {
  return amount != null && months
    ? D.preview(cur(Math.round(amount * 100) / 100, currency), months)
    : "";
}
