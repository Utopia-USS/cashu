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

// ---- first steps: the loan form, installment matching (design/v3/first-steps sections 7-9) ------------------

/** Monthly annuity payment of `p` at `ratePct` % a year over `n` months (0 % = equal parts). The server's
 * `amortization.summarize` is the truth after saving; this preview only makes a typo (6,5 vs 65) visible. */
export function annuity(p: number, ratePct: number, n: number): number {
  const r = ratePct / 100 / 12;
  return r === 0 ? p / n : (p * r) / (1 - (1 + r) ** -n);
}

export type TermUnit = "years" | "months";
export const termMonths = (n: number, unit: TermUnit): number => (unit === "years" ? n * 12 : n);

/** Polish-typed number ("400 000", "6,5") -> number, else null. */
export function parseNum(text: string): number | null {
  const t = text.replace(/[\s  ]/g, "").replace(",", ".");
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface LoanDraft {
  name: string; principal: number | null; rate: number | null; term: number | null; unit: TermUnit;
  /** First instalment (YYYY-MM-DD). */
  start: string;
  /** Disbursement (optional, YYYY-MM-DD). */
  origination: string;
}
export type LoanErrors = Partial<Record<"name" | "principal" | "rate" | "term" | "start" | "origination", string>>;

/** The form's problems in Polish (empty object = valid). */
export function validateLoan(d: LoanDraft): LoanErrors {
  const e: LoanErrors = {};
  if (!d.name.trim()) e.name = "Podaj nazwę.";
  if (d.principal == null || !(d.principal > 0)) e.principal = "Podaj kwotę większą od 0.";
  if (d.rate == null || d.rate < 0 || d.rate > 100) e.rate = "Oprocentowanie od 0 do 100.";
  const maxTerm = d.unit === "years" ? 50 : 600;
  if (d.term == null || !Number.isInteger(d.term) || d.term < 1 || d.term > maxTerm) {
    e.term = d.unit === "years" ? "Okres od 1 do 50 lat." : "Okres od 1 do 600 miesięcy.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start)) e.start = "Podaj datę pierwszej raty.";
  else if (d.origination && d.origination > d.start) e.origination = "Wypłata nie może być po pierwszej racie.";
  return e;
}

/** The 1st of the current month (the CLI's default first instalment). */
export const firstOfMonth = (today: string): string => `${today.slice(0, 7)}-01`;

/** Candidates for the installment phrase: active monthly-ish payments (gap 25-35 days), largest first, 6 at most. */
export function installmentCandidates<T extends { active: boolean; gap_days: number; amount: number }>(items: readonly T[]): T[] {
  return items.filter((i) => i.active && i.gap_days >= 25 && i.gap_days <= 35)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 6);
}

/** How the loan's installments are recognised: the phrase, the IBAN tail, the built-in phrases (step done
 * without either), else null. */
export function paymentHint(l: { payment_text?: string | null; payment_iban_tail?: string | null }, stepDone: boolean): string | null {
  if (l.payment_text) return `fraza „${l.payment_text}"`;
  if (l.payment_iban_tail) return `IBAN …${l.payment_iban_tail}`;
  return stepDone ? "rozpoznane z wbudowanych fraz" : null;
}

/** Up to `cap` items joined with ` · `, then `+n`. */
export function capJoin(parts: string[], cap = 2): string {
  return parts.length > cap ? `${parts.slice(0, cap).join(" · ")} · +${parts.length - cap}` : parts.join(" · ");
}
