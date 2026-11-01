/**
 * Producer of `loans.valuation` (`parity/python/checks/loans_assets.py:loans`): per profile, each listed
 * loan (visible account, id order) with its API summary (`loan_summary`, JSON floats), the raw
 * `summarize` result, its anchors, `latest(None)` and the valuation at the probe dates.
 * `@cashu/domain` loans does the math; this file only shapes the golden's JSON.
 */

import { type Decimal, loans } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { loanTerms, recordedBalances } from "../core/book.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { probeDates } from "./probes.ts";

/** `core/api.py:f`: Decimal -> JSON number. */
const f = (d: Decimal) => pyFloat(d.toFloat());

function rawRow(r: loans.ScheduleRow): OutValue {
  return {
    n: BigInt(r.n),
    date: r.date,
    payment: r.payment,
    interest: r.interest,
    principal: r.principal,
    balance: r.balance,
  };
}

function apiRow(r: loans.ScheduleRow): OutValue {
  return {
    n: BigInt(r.n),
    date: r.date,
    payment: f(r.payment),
    interest: f(r.interest),
    principal: f(r.principal),
    balance: f(r.balance),
  };
}

function summaryOut(s: loans.LoanSummaryView): OutValue {
  return {
    id: s.id,
    account_id: s.accountId,
    name: s.name,
    type: s.type,
    has_loan: s.hasLoan,
    currency: s.currency,
    principal: f(s.principal),
    annual_rate: f(s.annualRate),
    term_months: BigInt(s.termMonths),
    monthly_payment: f(s.monthlyPayment),
    start_date: s.startDate,
    outstanding: f(s.outstanding),
    schedule_outstanding: f(s.scheduleOutstanding),
    balance_source: s.balanceSource,
    months_elapsed: BigInt(s.monthsElapsed),
    paid_principal: f(s.paidPrincipal),
    paid_interest: f(s.paidInterest),
    remaining_interest: f(s.remainingInterest),
    total_interest: f(s.totalInterest),
    payoff_date: s.payoffDate,
    payment_iban_tail: s.paymentIbanTail,
    payment_text: s.paymentText,
    series: s.summary.schedule.map((r) => ({ date: r.date, balance: f(r.balance) })),
    schedule: s.summary.schedule.map(apiRow),
  };
}

function rawOut(s: loans.LoanSummary): OutValue {
  return {
    principal: s.principal,
    annual_rate: s.annualRate,
    term_months: BigInt(s.termMonths),
    start_date: s.startDate,
    monthly_payment: s.monthlyPayment,
    outstanding: s.outstanding,
    months_elapsed: BigInt(s.monthsElapsed),
    paid_principal: s.paidPrincipal,
    paid_interest: s.paidInterest,
    total_interest: s.totalInterest,
    remaining_interest: s.remainingInterest,
    payoff_date: s.payoffDate,
    schedule: s.schedule.map(rawRow),
  };
}

export function produceLoansValuation(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const terms = loanTerms(db, p.id);
    const recorded = recordedBalances(db, p.id);
    const accounts = db.accounts(p.id, { includeRemoved: true }).map((a) => ({
      ...a,
      id: db.keys.key("accounts", a.id),
    }));
    const rows: OutValue[] = [];
    for (const [loan, account] of loans.listLoans(terms, accounts)) {
      const lv = loans.loanValuation(loan, recorded.get(loan.accountId) ?? []);
      const summary = loans.loanSummary(loan, account, lv, db.asOf, account.currency);
      const raw = loans.summarize(
        loan.principal,
        loan.annualRate,
        loan.termMonths,
        loan.startDate,
        db.asOf,
        loan.originationDate,
      );
      rows.push({
        loan_id: loan.id,
        summary: summaryOut(summary),
        summary_raw: rawOut(raw),
        anchors: lv.anchors.map(([d, a]) => [d, a]),
        latest: [...lv.latest(null, db.asOf)],
        valuation: probeDates(loan.startDate, db.asOf).map((d) => ({
          date: d,
          at: lv.at(d),
          scheduled: lv.scheduled(d),
          source: lv.source(d),
        })),
      });
    }
    out[db.keys.key("profiles", p.id)] = rows;
  }
  return out;
}
