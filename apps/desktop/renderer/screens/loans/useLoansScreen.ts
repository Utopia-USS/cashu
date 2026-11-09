// Kredyty (ab24ab6 modules/loans/Loans.tsx, Start.tsx, Drawers.tsx): the native loans, setup steps, recurring
// payments and the two loan commands, adapted to what the old views got. Command outcomes stay durable (an
// uncertain attempt is reconciled first).
import { normalizeIban } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S as DS } from "@cashu/i18n/loans/Drawers.strings";
import { S as T } from "@cashu/i18n/loans/Start.strings";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { createUiLoan, loansScreen, setUiLoanPayment } from "@cashu/store/loans/screen";
import { overviewQueries } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { cur } from "@cashu/ui-logic/core/format";
import { label } from "@cashu/ui-logic/core/messages";
import {
  annuity,
  installmentCandidates,
  parseNum,
  termMonths,
  validateLoan,
} from "@cashu/ui-logic/loans/logic";
import { useEffect, useRef, useState } from "react";
import { O } from "../CommandOutcome.strings.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { L } from "./Loans.strings.js";
import {
  initialLoanForm,
  type LoanFormValues,
  loanInput,
  type PaymentMode,
  paymentInput,
} from "./loanForm.js";
import {
  dmShort,
  listRows,
  loanDetail,
  loanName,
  previewText,
  startSteps,
  stepsTag,
} from "./loansModel.js";

const q = overviewQueries({ prices: null });

type Drawer = { kind: "loan" } | { kind: "payment" } | null;

export function useLoansScreen(today: string) {
  const toast = useToast();
  const rows = useQuery(loansScreen, { today });
  const recurring = useQuery(budgetDesktopQueries().subscriptions);
  const hero = useQuery(q.hero, { today });
  const setup = useQuery(q.moduleSetup, { module: "loans", cli: "", lang: lang() });
  const modules = useQuery(q.moduleStates);
  const base = hero.facts.currency;
  const budgetOn = modules.some((m) => m.id === "budget" && m.enabled);
  const setupState = modules.find((m) => m.id === "loans")?.setupState ?? "empty";
  const info = setup.ok ? setup.value : null;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = useCommand(createUiLoan);
  const payment = useCommand(setUiLoanPayment);
  const durable = useDurableCommands();

  // ---- the tab: selected loan (old index state) and its chart range (reset with the loan, old `key={i}`)
  const [sel, setSel] = useState(0);
  const [range, setRange] = useState<number | null>(null);
  const i = Math.min(sel, Math.max(0, rows.length - 1));
  const current = rows[i] ?? null;
  const select = (k: number) => {
    if (k !== i) setRange(null);
    setSel(k);
  };

  // ---- drawers
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [form, setForm] = useState<LoanFormValues>(() => initialLoanForm(today, base));
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [payId, setPayId] = useState<string | null>(null);
  const [mode, setModeState] = useState<PaymentMode>("text");
  const [text, setText] = useState("");
  const [iban, setIban] = useState("");
  const busy = create.isPending || payment.isPending;
  const uncertain = () =>
    durable.uncertain("loan") || (payId !== null && durable.uncertain(`payment:${payId}`));

  const draft = {
    name: form.name,
    principal: parseNum(form.principal),
    rate: parseNum(form.annualRate),
    term: parseNum(form.term),
    unit: form.unit,
    start: form.startDate,
    origination: form.originationDate,
  };
  const errors = validateLoan(draft);
  const months = draft.term != null ? termMonths(draft.term, form.unit) : null;
  const preview =
    !errors.principal && !errors.rate && !errors.term && months && draft.principal != null
      ? previewText(annuity(draft.principal, draft.rate ?? 0, months), months, form.currency)
      : "";

  const close = () => {
    if (uncertain()) {
      setErr(O.unknown);
      return;
    }
    if (!busy) {
      setDrawer(null);
      setErr(null);
    }
  };
  const openLoan = () => {
    if (uncertain()) {
      setErr(O.unknown);
      return;
    }
    setForm(initialLoanForm(today, base));
    setTouched(false);
    setErr(null);
    setDrawer({ kind: "loan" });
  };
  const pick = (account: string) => {
    setPayId(account);
    setText(rows.find((r) => r.accountId === account)?.paymentText ?? "");
    setIban("");
  };
  const openPayment = (account: string | null) => {
    if (uncertain()) {
      setErr(O.unknown);
      return;
    }
    const first = account ?? rows[0]?.accountId ?? null;
    if (first === null) return;
    pick(first);
    setModeState("text");
    setErr(null);
    setDrawer({ kind: "payment" });
  };

  const saveLoan = async () => {
    setTouched(true);
    if (Object.keys(errors).length || !months) return;
    setErr(null);
    let input: ReturnType<typeof loanInput>;
    try {
      input = loanInput(form);
    } catch {
      setErr(L.invalid);
      return;
    }
    try {
      const result = await durable.run("loan", create, input);
      if (!mounted.current) return;
      if (result.kind !== "completed") {
        setErr(
          result.kind === "refused" && result.reason === "loan_name_taken"
            ? (label("error.loan_name_taken") ?? L.invalid)
            : commandFailure(result, L.invalid),
        );
        return;
      }
      toast(T.added(input.name).trim(), 2500);
      setDrawer(null);
    } catch {
      if (mounted.current) setErr(L.refused);
    }
  };

  // The recognised count comes from the live loans read once it shows the new matching (old `matched`).
  const awaiting = useRef<{ account: string; mode: PaymentMode; value: string } | null>(null);
  useEffect(() => {
    const a = awaiting.current;
    if (!a) return;
    const row = rows.find((r) => r.accountId === a.account);
    const shown =
      a.mode === "text"
        ? row?.paymentText === a.value
        : row?.paymentIbanTail === Array.from(normalizeIban(a.value)).slice(-4).join("");
    if (!row || !shown) return;
    awaiting.current = null;
    if (row.matched) toast(DS.matched(row.matched), 3000);
    else toast(DS.noMatch, 4000);
  });

  const sendPayment = async (value: string) => {
    if (payId === null) return;
    setErr(null);
    try {
      const result = await durable.run(
        `payment:${payId}`,
        payment,
        paymentInput(payId, mode, value),
      );
      if (!mounted.current) return;
      if (result.kind !== "completed") {
        setErr(DS.notSaved(commandFailure(result, L.invalidPayment)));
        return;
      }
      if (!value) toast(DS.cleared, 2500);
      else awaiting.current = { account: payId, mode, value };
      setIban("");
      setDrawer(null);
    } catch {
      if (mounted.current) setErr(DS.notSaved(L.refused));
    }
  };

  const candidates = installmentCandidates(
    recurring.map((r) => ({
      payee: r.counterparty,
      currency: r.currency,
      amount: r.typicalAmount.toFloat(),
      gap_days: r.medianGapDays,
      last: r.lastDate,
      active: r.active,
    })),
  );
  const payLoan = rows.find((r) => r.accountId === payId) ?? null;
  const payIndex = payLoan ? rows.indexOf(payLoan) : -1;

  return {
    /** Old shell: an empty module's tab is its first steps. */
    empty: setupState === "empty",
    rows: listRows(rows),
    count: rows.length,
    selected: i,
    select,
    detail: current ? loanDetail(current, loanName(current, i)) : null,
    range,
    setRange,
    start: {
      tag: stepsTag(info),
      steps: startSteps({
        steps: info?.steps ?? null,
        budgetOn,
        loans: rows,
        base,
        openLoan,
        openPayment,
      }),
    },
    drawer,
    busy,
    err,
    close,
    loan: {
      form,
      set: <K extends keyof LoanFormValues>(key: K, value: LoanFormValues[K]) =>
        setForm((f) => ({ ...f, [key]: value })),
      errors: touched ? errors : {},
      preview,
      currencies: [...new Set([base, "PLN", "EUR", "USD", "CHF"])],
      save: saveLoan,
    },
    payment: {
      loans: rows.map((r, k) => ({ value: r.accountId, label: loanName(r, k) })),
      account: payId ?? "",
      name: payLoan ? loanName(payLoan, payIndex) : null,
      pick,
      mode,
      setMode: (m: PaymentMode) => {
        setModeState(m);
        setErr(null);
      },
      text,
      setText,
      iban,
      setIban,
      storedTail: payLoan?.paymentIbanTail ?? null,
      stored: mode === "text" ? !!payLoan?.paymentText : !!payLoan?.paymentIbanTail,
      candidates: candidates.map((c) => ({
        key: `${c.payee}|${c.currency}|${c.amount}`,
        payee: c.payee,
        detail: DS.candidate(cur(Math.abs(c.amount), c.currency), c.gap_days, dmShort(c.last)),
      })),
      send: sendPayment,
    },
  };
}
export type LoansState = ReturnType<typeof useLoansScreen>;
