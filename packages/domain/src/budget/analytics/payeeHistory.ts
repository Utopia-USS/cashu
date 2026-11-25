/**
 * One payee's charges year by year (a yearly insurance, a subscription renewal): each charge against the
 * next older one, newest first. One merchant and one currency, never mixed.
 */

import type { IsoDate } from "../../dates.js";
import { D, type Decimal } from "../../decimal.js";

export interface PayeeHit {
  readonly key: string;
  readonly merchantKey: string;
  readonly payee: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
}

export interface PayeeYearRow {
  readonly key: string;
  readonly year: number;
  readonly date: IsoDate;
  readonly amount: Decimal;
  /** `(|amount| - |older|) / |older| * 100` against the next older hit; null for the oldest. */
  readonly vsPreviousPct: number | null;
}

export interface PayeeSummary {
  /** The newest hit's payee name. */
  readonly payee: string;
  readonly merchantKey: string;
  readonly currency: string;
  readonly count: number;
  /** The oldest hit's year. */
  readonly since: number;
  /** Newest first. */
  readonly rows: readonly PayeeYearRow[];
}

const HUNDRED = D("100");

/**
 * The payee summary, or null unless there are at least 2 hits and all of them share one merchant key
 * and one currency (mixed hits are refused, never merged).
 */
export function payeeSummary(hits: readonly PayeeHit[]): PayeeSummary | null {
  const first = hits[0];
  if (first === undefined || hits.length < 2) return null;
  if (hits.some((h) => h.merchantKey !== first.merchantKey || h.currency !== first.currency)) {
    return null;
  }
  const sorted = [...hits].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const rows = sorted.map((h, i): PayeeYearRow => {
    const older = sorted[i + 1];
    const previous = older?.amount.copyAbs();
    return {
      key: h.key,
      year: Number(h.date.slice(0, 4)),
      date: h.date,
      amount: h.amount,
      vsPreviousPct:
        previous === undefined || previous.isZero()
          ? null
          : h.amount.copyAbs().sub(previous).div(previous).mul(HUNDRED).toFloat(),
    };
  });
  const newest = sorted[0] as PayeeHit;
  const oldest = sorted[sorted.length - 1] as PayeeHit;
  return {
    payee: newest.payee,
    merchantKey: first.merchantKey,
    currency: first.currency,
    count: hits.length,
    since: Number(oldest.date.slice(0, 4)),
    rows,
  };
}
