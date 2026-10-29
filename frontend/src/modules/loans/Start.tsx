// Loans first steps in the app (design/v3/first-steps section 7): the loan itself (`LoanDrawer`) and, with the
// budget module, how its installments are recognised (`InstallmentDrawer`). Rendered for the empty Kredyty tab and
// for `setup/loans`.
import { useRef, useState } from "react";
import { useShell } from "../../core/context";
import { stepById } from "../../core/setupSteps";
import { StartPage, useSetupPoll } from "../../core/StartPage";
import type { ModuleCtx } from "../../core/types";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { type SetupStepItem, Tag, useToast } from "../../ui";
import { getLoans, type LoanInfo, loanName } from "./api";
import { InstallmentDrawer, LoanDrawer } from "./Drawers";
import { capJoin, paymentHint, rateText } from "./logic";
import { S } from "./Start.strings.ts";

type DrawerState = { kind: "loan" } | { kind: "payment"; id: number | null };

export function LoansStart({ ctx }: { ctx: ModuleCtx }) {
  const { slug } = ctx;
  const { reloadProfiles } = useShell();
  const toast = useToast();
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [nonce, setNonce] = useState(0);
  const stale = useRef(false);
  const setup = useSetupPoll(slug, "loans", ctx.state, drawer != null);
  const loansQ = useAsync(() => getLoans(slug), [slug, nonce], { key: ck(slug, "loans") });
  const loans = loansQ.data ?? [];
  const budgetOn = ctx.profile.modules.some((m) => m.id === "budget" && m.enabled);
  const steps = setup.data?.steps ?? null;
  const loanStep = stepById(steps, "loan");
  const payStep = budgetOn ? stepById(steps, "payments") : null;
  const reload = () => { setNonce((n) => n + 1); setup.reload(); };

  const close = () => {
    setDrawer(null);
    if (stale.current) { stale.current = false; ctx.refresh(); void reloadProfiles(); }
  };
  const loanLine = (l: LoanInfo, i: number) => {
    const c = l.currency || ctx.profile.base_currency;
    return [loanName(l, i), rateText(l.annual_rate), l.monthly_payment != null ? S.installment(cur(l.monthly_payment, c)) : null, l.payoff_date ? S.until(l.payoff_date.slice(0, 4)) : null]
      .filter(Boolean).join(" · ");
  };
  const loanDone = loanStep?.status === "done" && loans.length > 0;
  const payDone = payStep?.status === "done";
  const firstOpen = loans.find((l) => !l.payment_text && !l.payment_iban_tail)?.id ?? loans[0]?.id ?? null;

  const items: SetupStepItem[] | null = steps ? [
    {
      key: "loan", status: loanStep?.status ?? "on", title: S.loan,
      tag: loanDone ? <Tag tone="pos">{S.nLoans(loans.length)}</Tag> : undefined,
      hint: loanDone ? capJoin(loans.map(loanLine)) : S.loanHint,
      actions: loanStep?.status === "done"
        ? <button className="btn" onClick={() => setDrawer({ kind: "loan" })}>{S.addAnother}</button>
        : <button className="btn primary" onClick={() => setDrawer({ kind: "loan" })}>{S.addLoan}</button>,
    },
    ...(payStep ? [{
      key: "payments", status: payStep.status, title: S.payments,
      hint: payDone && loans.length
        ? capJoin(loans.map((l, i) => { const h = paymentHint(l, true); return h ? `${loanName(l, i)} · ${h}` : loanName(l, i); }))
        : S.paymentsHint,
      actions: payStep.status === "todo" || !loans.length ? undefined : payDone
        ? <button className="btn" onClick={() => setDrawer({ kind: "payment", id: firstOpen })}>{S.change}</button>
        : <button className="btn primary" onClick={() => setDrawer({ kind: "payment", id: firstOpen })}>{S.pick}</button>,
    } satisfies SetupStepItem] : []),
  ] : null;

  return (
    <StartPage moduleId="loans" title={S.title} setup={setup.data} state={ctx.state} steps={items}>
      {drawer?.kind === "loan" && (
        <LoanDrawer slug={slug} base={ctx.profile.base_currency} onClose={close}
          onSaved={(l) => { stale.current = true; toast(S.added(l.name ?? "").trim(), 2500); reload(); close(); }} />
      )}
      {drawer?.kind === "payment" && (
        <InstallmentDrawer slug={slug} loans={loans} initialId={drawer.id} onClose={close}
          onSaved={() => { stale.current = true; reload(); close(); }} />
      )}
    </StartPage>
  );
}
