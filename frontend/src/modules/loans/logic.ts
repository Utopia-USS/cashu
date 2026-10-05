// Pure helpers of the loans widgets (no React, no DOM); tested in tests/loans.test.mjs.

/** The annual rate as text. The API sends a percent (7.25 = 7,25 %, loans/amortization.py), so a 0,85 %
 * loan is "0,85 %", never 85 % (F7 FE9: no fraction-vs-percent guess). */
export function rateText(annualRatePct: number | null | undefined): string | null {
  if (annualRatePct == null || !Number.isFinite(annualRatePct)) return null;
  return `${annualRatePct.toLocaleString("pl-PL", { maximumFractionDigits: 2 })} %`;
}

/** Share of the monthly income (complete months) the instalments take; null without an income norm. */
export function incomeShare(payments: number | null | undefined, income: number | null | undefined): number | null {
  return payments && income && income > 0 ? payments / income : null;
}
