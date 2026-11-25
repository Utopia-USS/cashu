import { budget, D, type Decimal, loans, ZERO } from "@cashu/domain";
import { budgetBook } from "@cashu/store/budget/queries";
import { enabledModuleIds } from "@cashu/store/core";
import { mcpLoanRows } from "@cashu/store/loans/queries";
import * as L from "../privacy/labels.js";
import { type ToolContext, type ToolSpec, toolSpec } from "../registry.js";
import { encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";

function loansSummary(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const budgetOn = enabledModuleIds(ctx.store.read).has("budget");
  const book = budgetOn ? budgetBook(ctx.store.read) : null;
  const incomes = new Map<string, Decimal | null>();
  return {
    loans: mcpLoanRows(ctx.store.read).map(({ loan, account, balances }) => {
      const summary = loans.summarize(
        loan.principal,
        loan.annualRate,
        loan.termMonths,
        loan.startDate,
        ctx.today,
        loan.originationDate,
      );
      const valuation = loans.loanValuation(loan, balances);
      const outstanding = valuation.at(ctx.today);
      if (book !== null && !incomes.has(account.currency)) {
        const rows = budget.monthlyCashflow(book, account.currency).slice(-3);
        const total = rows.reduce((sum, row) => sum.add(row.income), ZERO);
        incomes.set(
          account.currency,
          rows.length === 0 || total.isZero() ? null : total.div(D(BigInt(rows.length))),
        );
      }
      return {
        loan_id: L.ref(encodeEntityRef("loan", loan.id)),
        account: L.account(ctx.accountLabels.get(account.id) ?? null),
        name: L.identifier(account.name),
        type: L.category(account.type),
        currency: L.category(account.currency),
        annual_rate_pct: L.pct(summary.annualRate, 4),
        term_months: L.count(summary.termMonths),
        months_elapsed: L.count(summary.monthsElapsed),
        remaining_months: L.count(Math.max(0, summary.termMonths - summary.monthsElapsed)),
        payoff_date: L.date(summary.payoffDate),
        paid_share_of_principal: L.share(summary.paidPrincipal, summary.principal),
        outstanding_share_of_principal: L.share(outstanding, summary.principal),
        installment_share_of_income: L.share(
          summary.monthlyPayment,
          incomes.get(account.currency) ?? null,
        ),
        balance_source: L.category(valuation.source(ctx.today)),
        payment_account: L.identifier(loan.paymentIban),
        payment_text: L.identifier(loan.paymentText),
        principal: L.amount(summary.principal),
        outstanding: L.amount(outstanding),
        monthly_payment: L.amount(summary.monthlyPayment),
        remaining_interest: L.amount(summary.remainingInterest),
      };
    }),
    base_note: L.text(
      budgetOn
        ? "installment_share_of_income: monthly installment vs the average monthly income of the last 3 months (budget module)"
        : "installment_share_of_income needs the budget module",
    ),
  };
}
export function loansTools(): readonly ToolSpec<NativeToolStore>[] {
  return [
    toolSpec({
      name: "loans_summary",
      module: "loans",
      description:
        "Per loan: interest rate, remaining months, payoff date, paid share, installment as a share of income (when the budget module is on).",
      handler: loansSummary,
    }),
  ];
}
