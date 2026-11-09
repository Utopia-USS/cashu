/**
 * The banana scale of the privacy mode: instead of hiding amounts, every money amount is shown as a
 * share of one per-profile anchor, with the anchor itself worth 🍌 1000. The anchor is the average
 * monthly salary when the budget knows one, else a tenth of the investment portfolio. Proportions stay
 * readable (a rent of 🍌 280, a portfolio of 🍌 30 000), the scale does not.
 *
 * The factor is exactly 1000 / anchor, never rounded to a "nice" number: a rounded factor would let
 * the anchor's own banana value give the real amount away. Another currency goes through its PLN rate
 * first; without a rate there is no banana value and the caller masks the amount as before.
 *
 * Pure: the caller hands over the months, the portfolio total and the rates.
 */

import { D, type Decimal, ZERO } from "../decimal.js";

/** What 🍌 1000 stands for. */
export const BANANA_ANCHOR = 1000;

/** The months the salary average looks back over. */
export const SALARY_MONTHS = 12;

/** The portfolio share worth 🍌 1000 when there is no salary. */
export const PORTFOLIO_SHARE = D("0.1");

export type BananaAnchorKind = "salary" | "portfolio";

export interface BananaScale {
  readonly anchor: BananaAnchorKind;
  /** Bananas per 1 PLN. */
  readonly perPln: number;
  /** PLN per 1 unit of each other currency (the latest NBP rate). */
  readonly plnRates: Readonly<Record<string, number>>;
}

/** One calendar month of the budget: its salary inflow (PLN) and whether it has any budget data. */
export interface SalaryMonth {
  /** "YYYY-MM". */
  readonly month: string;
  readonly salary: Decimal;
  readonly hasData: boolean;
}

/**
 * The average monthly salary over the last up to 12 complete months with budget data (the running
 * month never counts). Months without a salary inside that window count as zero, so a yearly bonus
 * or a quarterly payout averages out over the year. null without a single salary in the window.
 */
export function salaryAnchor(months: readonly SalaryMonth[], today: string): Decimal | null {
  const current = today.slice(0, 7);
  const window = months
    .filter((m) => m.month < current && m.hasData)
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .slice(-SALARY_MONTHS);
  let total = ZERO;
  for (const m of window) total = total.add(m.salary);
  if (window.length === 0 || !total.gt(ZERO)) return null;
  return total.div(D(String(window.length)));
}

/** A tenth of the portfolio's PLN value; null when there is nothing invested. */
export function portfolioAnchor(totalPln: Decimal | null): Decimal | null {
  if (totalPln === null || !totalPln.gt(ZERO)) return null;
  return totalPln.mul(PORTFOLIO_SHARE);
}

/** The scale for an anchor in PLN; null without a positive anchor (the privacy mode then masks). */
export function bananaScale(
  anchor: BananaAnchorKind,
  anchorPln: Decimal | null,
  plnRates: Readonly<Record<string, number>>,
): BananaScale | null {
  if (anchorPln === null) return null;
  const pln = Number(anchorPln.toString());
  if (!Number.isFinite(pln) || pln <= 0) return null;
  return { anchor, perPln: BANANA_ANCHOR / pln, plnRates };
}

/** An amount in bananas, or null when its currency has no PLN rate. */
export function toBananas(
  scale: BananaScale,
  amount: number | Decimal, // float-ok: banana values are display approximations; the renderer formats numbers
  currency: string,
): number | null {
  const value = typeof amount === "number" ? amount : Number(amount.toString()); // float-ok: display only
  if (!Number.isFinite(value)) return null;
  const rate = currency === "PLN" ? 1 : scale.plnRates[currency];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return value * rate * scale.perPln;
}
