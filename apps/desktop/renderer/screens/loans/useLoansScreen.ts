import { D, loans, Money } from "@cashu/domain";
import { intlLocale, lang } from "@cashu/i18n";
import { S as F } from "@cashu/i18n/loans/Drawers.strings";
import { formatCalendarDate, formatDecimalValue } from "@cashu/i18n/values";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { createUiLoan, loansScreen, setUiLoanPayment } from "@cashu/store/loans/screen";
import { overviewQueries } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import { L } from "./Loans.strings.js";
import { initialLoanForm, loanInput, useLoanForm } from "./useLoanForm.js";
import {
  initialPaymentForm,
  type PaymentFormValues,
  paymentInput,
  usePaymentForm,
} from "./usePaymentForm.js";

const q = overviewQueries({ prices: null });

export function useLoansScreen(today: string) {
  const rows = useQuery(loansScreen, { today });
  const recurring = useQuery(budgetDesktopQueries().subscriptions);
  const candidates = recurring
    .filter((row) => row.active && row.medianGapDays >= 25 && row.medianGapDays <= 35)
    .sort((a, b) => b.typicalAmount.abs().compare(a.typicalAmount.abs()))
    .slice(0, 6);
  const profile = useQuery(q.hero, { today });
  const setup = useQuery(q.moduleSetup, { module: "loans", cli: "", lang: lang() });
  const modules = useQuery(q.moduleStates);
  const { privacy } = useUiEnv();
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<"loan" | "payment" | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [range, setRange] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = useCommand(createUiLoan);
  const payment = useCommand(setUiLoanPayment);
  const busy = create.isPending || payment.isPending;
  const current = rows.find((r) => r.id === selected) ?? rows[0] ?? null;
  const loanForm = useLoanForm(today, profile.facts.currency, async (value) => {
    setError(null);
    try {
      const result = await create.run(loanInput(value));
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.reason === "loan_name_taken" ? L.taken : L.invalid);
        return;
      }
      setDrawer(null);
      setSelected(null);
    } catch {
      if (mounted.current) setError(L.invalid);
    }
  });
  const runPayment = async (value: typeof initialPaymentForm, clear = false) => {
    if (!rows.some((row) => row.accountId === value.account)) return false;
    setError(null);
    try {
      const result = await payment.run(paymentInput(value, clear));
      if (!mounted.current) return false;
      if (!result.ok) {
        setError(L.invalidPayment);
        return false;
      }
      setDrawer(null);
      setNotice(clear ? L.cleared : F.payments);
      return true;
    } catch {
      if (mounted.current) setError(L.refused);
      return false;
    }
  };
  const [paymentDefaults, setPaymentDefaults] = useState<PaymentFormValues>(initialPaymentForm);
  const paymentForm = usePaymentForm(runPayment, paymentDefaults);
  const loanState = useStore(loanForm.store, (state) => state);
  const form = loanState.values;
  const paymentState = useStore(paymentForm.store, (state) => state);
  const paymentValues = paymentState.values;
  const { mode, text, iban } = paymentValues;
  const matchingLoan = rows.find((row) => row.accountId === paymentValues.account) ?? null;
  const close = () => {
    if (!busy) {
      setDrawer(null);
      setError(null);
      paymentForm.setFieldValue("iban", "");
    }
  };
  const openLoan = () => {
    loanForm.reset(initialLoanForm(today, profile.facts.currency));
    setError(null);
    setDrawer("loan");
  };
  const pickPayment = (account: string) => {
    const row = rows.find((entry) => entry.accountId === account);
    const next = { ...initialPaymentForm, account, text: row?.paymentText ?? "" };
    setPaymentDefaults(next);
    paymentForm.reset(next);
    setError(null);
  };
  const openPayment = () => {
    const first = rows.find((row) => !row.paymentText && !row.paymentIbanTail) ?? current;
    if (first) {
      pickPayment(first.accountId);
      setDrawer("payment");
      setError(null);
    }
  };
  const submitLoan = () => loanForm.handleSubmit();
  const submitPayment = async (clear = false) => {
    if (clear) {
      if (await runPayment(paymentValues, true)) paymentForm.setFieldValue("iban", "");
    } else await paymentForm.handleSubmit();
  };
  const setMode = (value: "text" | "iban") => paymentForm.setFieldValue("mode", value);
  const setText = (value: string) => paymentForm.setFieldValue("text", value);
  const setIban = (value: string) => paymentForm.setFieldValue("iban", value);
  let preview: Money | null = null;
  try {
    const input = loanInput(form);
    const months = input.termMonths;
    const p = D(input.principal);
    const rate = D(input.annualRate);
    if (
      p.gt(D("0")) &&
      rate.gte(D("0")) &&
      rate.lte(D("100")) &&
      Number.isInteger(months) &&
      months >= 1 &&
      months <= 600
    )
      preview = new Money(loans.monthlyPayment(p, rate, months), form.currency);
  } catch {
    /* Incomplete form values have no preview. */
  }
  const schedule = current?.summary.schedule ?? [];
  const limit =
    range === null || schedule[0] === undefined
      ? null
      : new Date(Date.parse(`${schedule[0].date}T12:00:00Z`) + range * 86400000)
          .toISOString()
          .slice(0, 10);
  const points = limit === null ? schedule : schedule.filter((p) => p.date <= limit);
  const locale = intlLocale();
  const chartLabels = [0, Math.floor(points.length / 2), points.length - 1]
    .filter((index, position, all) => index >= 0 && all.indexOf(index) === position)
    .flatMap((index) => {
      const point = points[index];
      return point ? [{ i: index, text: formatCalendarDate(point.date, locale, "short") }] : [];
    });
  const display = (value: ReturnType<typeof D>) =>
    formatDecimalValue(value, locale, { currency: current?.currency ?? profile.facts.currency })
      .text;
  const last = points.at(-1);
  const low = points.reduce(
    (best, point) => (point.balance.lt(best) ? point.balance : best),
    last?.balance ?? D("0"),
  );
  const high = points.reduce(
    (best, point) => (point.balance.gt(best) ? point.balance : best),
    last?.balance ?? D("0"),
  );
  const chartSummary = last
    ? L.chartSummary(display(last.balance), display(low), display(high))
    : L.empty;
  const chartTip = (i: number) => {
    const p = points[i];
    return {
      title: p ? formatCalendarDate(p.date, locale) : "",
      rows: p
        ? [
            {
              name: F.principal,
              value: formatDecimalValue(p.balance, locale, {
                currency: current?.currency ?? profile.facts.currency,
              }).text,
              amount: true,
            },
          ]
        : [],
    };
  };
  return {
    candidates,
    rows,
    current,
    selected: current?.id ?? null,
    setSelected,
    setup,
    budgetOn: modules.some((m) => m.id === "budget" && m.enabled),
    privacy,
    drawer,
    form,
    loanForm,
    paymentForm,
    mode,
    setMode,
    text,
    setText,
    iban,
    setIban,
    error:
      error ??
      (loanState.isSubmitted && !loanState.isValid
        ? L.invalid
        : paymentState.isSubmitted && !paymentState.isValid
          ? L.invalidPayment
          : null),
    notice: notice === F.payments ? F.matched(matchingLoan?.matched ?? 0) : notice,
    busy,
    matchingLoan,
    pickPayment,
    openLoan,
    openPayment,
    close,
    submitLoan,
    submitPayment,
    preview,
    range,
    setRange,
    points,
    chartTip,
    chartLabels,
    chartSummary,
  };
}
export type LoansState = ReturnType<typeof useLoansScreen>;
