/**
 * What a loan account is worth (owed) on a given date (`modules/loans/valuation.py`).
 *
 * The amortization schedule gives the outstanding principal for any date. A balance recorded for
 * the loan account after its terms were last set (a bank statement entered by hand or imported) is
 * more authoritative than the model: from its date on the loan is worth that figure, reduced by the
 * principal the schedule repays after it. Balances recorded before the terms (the placeholder value
 * given when the position was added) are superseded by the terms and ignored.
 *
 * Python reads the account's balances through the session; here the caller passes the loan's terms
 * and the account's balance rows (`loanValuation`).
 */

import { type LatestEntry, type Valuation, ZERO_00 } from "../core/index.js";
import { type DateTime, type IsoDate, toStorage } from "../dates.js";
import type { Decimal } from "../decimal.js";
import { outstanding, type ScheduleRow, schedule } from "./amortization.js";

/** The terms of one loan (`models.Loan`), in the caller's id space. */
export interface LoanTerms {
  /** The loan's id (a gid in the store, a natural key or the app's id in parity). */
  readonly id: string;
  /** The liability account the terms belong to. */
  readonly accountId: string;
  readonly principal: Decimal;
  /** Percent, e.g. 6.27. */
  readonly annualRate: Decimal;
  readonly termMonths: number;
  /** First installment date. */
  readonly startDate: IsoDate;
  /** Disbursement: the debt exists from here (null = the first installment's date). */
  readonly originationDate: IsoDate | null;
  /** When the terms were last set (naive = UTC): balances recorded up to it are superseded. */
  readonly updatedAt: DateTime | string;
  /** Lender account the installments go to (normalized IBAN), null when not set. */
  readonly paymentIban: string | null;
  /** Phrase in the installment title, null when not set. */
  readonly paymentText: string | null;
}

/** A balance snapshot of the loan account with the moment it was recorded (`Balance.created_at`). */
export interface RecordedBalance {
  readonly date: IsoDate;
  readonly amount: Decimal;
  /** Naive = UTC (SQLite's convention); an aware value is converted. */
  readonly recordedAt: DateTime | string;
}

/** A balance the bank reported that drives the value from its date on. */
export type Anchor = readonly [IsoDate, Decimal];

/** `"recorded"` when a recorded balance drives the value at a date, else `"schedule"`. */
export type BalanceSource = "recorded" | "schedule";

/** A loan account's net-worth `Valuation` (raw value: the positive amount owed). */
export class LoanValuation implements Valuation {
  readonly loan: LoanTerms;
  readonly rows: readonly ScheduleRow[];
  /** Ascending by date (one per date). */
  readonly anchors: readonly Anchor[];

  constructor(loan: LoanTerms, anchors: readonly Anchor[]) {
    this.loan = loan;
    this.rows = schedule(loan.principal, loan.annualRate, loan.termMonths, loan.startDate);
    // Python sorted() over (date, amount): dates are unique per loan, so the date decides.
    this.anchors = [...anchors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The pure schedule's outstanding principal at `d`. */
  scheduled(d: IsoDate): Decimal {
    return outstanding(this.rows, d, this.loan.originationDate);
  }

  /** The last anchor on or before `d`. */
  anchor(d: IsoDate): Anchor | null {
    let last: Anchor | null = null;
    for (const a of this.anchors) {
      if (a[0] <= d) last = a;
      else break;
    }
    return last;
  }

  /** What is owed at `d`: the schedule, or the anchor less the principal repaid since. */
  at(d: IsoDate): Decimal {
    const anchor = this.anchor(d);
    if (anchor === null) return this.scheduled(d);
    const [ad, amount] = anchor;
    const repaidSince = this.scheduled(ad).sub(this.scheduled(d));
    const left = amount.abs().sub(repaidSince);
    // Python max(ZERO, left): ZERO unless left is strictly greater.
    return left.gt(ZERO_00) ? left : ZERO_00;
  }

  /** `latest(as_of)`: "now" (`asOf` null) is `today`. */
  latest(asOf: IsoDate | null, today: IsoDate): LatestEntry {
    const ref = asOf ?? today;
    return [ref, this.at(ref)];
  }

  /** The anchors' dates create points on the net-worth history. */
  axisDates(): IsoDate[] {
    return this.anchors.map(([d]) => d);
  }

  source(d: IsoDate): BalanceSource {
    return this.anchor(d) !== null ? "recorded" : "schedule";
  }
}

/** Naive-UTC storage text: fixed width, so it orders like the instant. */
function instantKey(value: DateTime | string): string {
  return toStorage(value);
}

/**
 * `loan_valuation`: the anchors are the account's balances recorded after the terms were set, the
 * latest recorded figure per day (on equal timestamps the later row wins). `balances` in storage
 * order (Python iterates the account's balances in id order).
 */
export function loanValuation(
  loan: LoanTerms,
  balances: readonly RecordedBalance[],
): LoanValuation {
  const termsSet = instantKey(loan.updatedAt);
  const byDate = new Map<IsoDate, { recorded: string; amount: Decimal }>();
  for (const b of balances) {
    const recorded = instantKey(b.recordedAt);
    if (recorded <= termsSet) continue;
    const current = byDate.get(b.date);
    if (current === undefined || recorded >= current.recorded) {
      byDate.set(b.date, { recorded, amount: b.amount });
    }
  }
  return new LoanValuation(
    loan,
    [...byDate.entries()].map(([d, v]) => [d, v.amount] as const),
  );
}
