/**
 * Mortgage / loan amortization (`modules/loans/amortization.py`): the annuity schedule and the
 * outstanding balance over time. Pure: the net-worth liability (outstanding as of a date, so
 * interest accrues and payments reduce it) and the loan tab's payoff view both read it.
 *
 * Decimal arithmetic runs in the current context (Python's thread context, 28 digits half-even);
 * every money figure is quantized to cents half-up like the Python code.
 */

import { addMonths, type IsoDate } from "../dates.js";
import { Decimal } from "../decimal.js";

/** `CENTS = Decimal("0.01")`: the quantum's exponent. */
const CENTS = -2;
const ZERO = Decimal.fromInt(0);
const ONE = Decimal.fromInt(1);
const HUNDRED = Decimal.fromInt(100);
const TWELVE = Decimal.fromInt(12);

function cents(value: Decimal): Decimal {
  return value.quantize(CENTS, "ROUND_HALF_UP");
}

/** Monthly rate: `annual_rate_pct / 100 / 12`. */
function monthlyRate(annualRatePct: Decimal): Decimal {
  return annualRatePct.div(HUNDRED).div(TWELVE);
}

/** `monthly_payment`: the fixed annuity installment. */
export function monthlyPayment(
  principal: Decimal,
  annualRatePct: Decimal,
  termMonths: number,
): Decimal {
  const i = monthlyRate(annualRatePct);
  if (i.isZero()) return cents(principal.div(Decimal.fromInt(termMonths)));
  const factor = ONE.add(i).pow(termMonths);
  return cents(principal.mul(i).mul(factor).div(factor.sub(ONE)));
}

/** One installment of the schedule (`ScheduleRow`). */
export interface ScheduleRow {
  /** 1-based installment number. */
  readonly n: number;
  readonly date: IsoDate;
  readonly payment: Decimal;
  readonly interest: Decimal;
  readonly principal: Decimal;
  /** Principal still owed after this installment. */
  readonly balance: Decimal;
}

/** `schedule`: month by month; the first payment falls on `startDate`. */
export function schedule(
  principal: Decimal,
  annualRatePct: Decimal,
  termMonths: number,
  startDate: IsoDate,
): ScheduleRow[] {
  const i = monthlyRate(annualRatePct);
  const pay = monthlyPayment(principal, annualRatePct, termMonths);
  const rows: ScheduleRow[] = [];
  let bal = principal;
  for (let k = 1; k <= termMonths; k++) {
    const interest = cents(bal.mul(i));
    let principalPart = pay.sub(interest);
    let thisPay = pay;
    if (k === termMonths || principalPart.gte(bal)) {
      // last installment / final settle
      principalPart = bal;
      thisPay = cents(principalPart.add(interest));
    }
    bal = cents(bal.sub(principalPart));
    rows.push({
      n: k,
      date: addMonths(startDate, k - 1),
      payment: thisPay,
      interest,
      principal: cents(principalPart),
      balance: bal,
    });
    if (bal.lte(ZERO)) break;
  }
  return rows;
}

/**
 * `outstanding`: remaining principal owed as of `asOf`.
 *
 * - before origination (disbursement): 0, the loan did not exist yet;
 * - between origination and the first installment: the full principal (no payment made yet);
 * - after: the amortized balance following the installments dated on or before `asOf`.
 *
 * `originationDate` defaults to the first installment's date (no gap).
 */
export function outstanding(
  rows: readonly ScheduleRow[],
  asOf: IsoDate,
  originationDate: IsoDate | null = null,
): Decimal {
  const first = rows[0];
  if (first === undefined) return ZERO;
  const orig = originationDate ?? first.date;
  if (asOf < orig) return ZERO;
  if (asOf < first.date) return first.balance.add(first.principal);
  let bal = first.balance;
  for (const r of rows) {
    if (r.date <= asOf) bal = r.balance;
    else break;
  }
  return bal;
}

/** `LoanSummary`: the loan's figures as of a date plus its full schedule. */
export interface LoanSummary {
  readonly principal: Decimal;
  readonly annualRate: Decimal;
  readonly termMonths: number;
  readonly startDate: IsoDate;
  readonly monthlyPayment: Decimal;
  readonly outstanding: Decimal;
  readonly monthsElapsed: number;
  readonly paidPrincipal: Decimal;
  readonly paidInterest: Decimal;
  readonly totalInterest: Decimal;
  readonly remainingInterest: Decimal;
  readonly payoffDate: IsoDate;
  readonly schedule: readonly ScheduleRow[];
}

/** `summarize`. */
export function summarize(
  principal: Decimal,
  annualRatePct: Decimal,
  termMonths: number,
  startDate: IsoDate,
  asOf: IsoDate,
  originationDate: IsoDate | null = null,
): LoanSummary {
  const rows = schedule(principal, annualRatePct, termMonths, startDate);
  const out = outstanding(rows, asOf, originationDate);
  let elapsed = 0;
  let paidInterest = ZERO;
  let totalInterest = ZERO;
  for (const r of rows) {
    if (r.date <= asOf) {
      elapsed += 1;
      paidInterest = paidInterest.add(r.interest);
    }
    totalInterest = totalInterest.add(r.interest);
  }
  const last = rows[rows.length - 1];
  return {
    principal,
    annualRate: annualRatePct,
    termMonths,
    startDate,
    monthlyPayment: monthlyPayment(principal, annualRatePct, termMonths),
    outstanding: out,
    monthsElapsed: elapsed,
    paidPrincipal: cents(principal.sub(out)),
    paidInterest: cents(paidInterest),
    totalInterest: cents(totalInterest),
    remainingInterest: cents(totalInterest.sub(paidInterest)),
    payoffDate: last === undefined ? startDate : last.date,
    schedule: rows,
  };
}
