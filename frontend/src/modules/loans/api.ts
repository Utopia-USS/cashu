// Loans module endpoints (profile-scoped). One profile can hold many loans.
import { ApiError, j, jpatch, jpost, pp } from "../../core/api";

export interface LoanInfo {
  // Identity of a list item; the contract keeps the upstream /loan shape per item,
  // so every field here is optional and the UI falls back gracefully.
  id?: number;
  name?: string;
  account?: string;
  has_loan?: boolean;
  currency?: string;
  principal?: number;
  /** Percent per year (7.25 = 7,25 %), never a fraction. */
  annual_rate?: number;
  monthly_payment?: number;
  outstanding?: number;
  total_interest?: number;
  paid_interest?: number;
  payoff_date?: string;
  months_elapsed?: number;
  term_months?: number;
  start_date?: string;
  type?: string;
  /** Installment matching (`set-payment`): the stored phrase, the last 4 digits of the stored IBAN (never the full number). */
  payment_text?: string | null;
  payment_iban_tail?: string | null;
  series?: { date: string; balance: number }[];
  schedule?: { n: number; date: string; payment: number; interest: number; principal: number; balance: number }[];
}

/** GET /api/p/{slug}/loans -> list (empty when the profile has no loans). Until the
 * backend serves /loans, falls back to the single-loan /loan endpoint (same item shape). */
export const getLoans = async (slug: string): Promise<LoanInfo[]> => {
  let r: LoanInfo[] | { items: LoanInfo[] } | LoanInfo;
  try {
    r = await j<LoanInfo[] | { items: LoanInfo[] }>(pp(slug, "/loans"));
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    r = await j<LoanInfo>(pp(slug, "/loan"));
  }
  const list = Array.isArray(r) ? r : "items" in r && Array.isArray(r.items) ? r.items : [r as LoanInfo];
  return list.filter((l) => l.has_loan !== false);
};

export const loanName = (l: LoanInfo, i: number): string => l.name || l.account || `Kredyt ${i + 1}`;

/** POST /loans (`loans add`): 201 one item of GET /loans; 409 `loan_name_taken`. `annual_rate` is a percent. */
export interface NewLoan {
  name: string; type: "mortgage" | "loan"; principal: number; annual_rate: number; term_months: number;
  start_date: string; origination_date?: string | null; currency?: string;
}
export const postLoan = (slug: string, body: NewLoan) => jpost<LoanInfo>(pp(slug, "/loans"), body);
/** PATCH /loans/{id}/payment (`set-payment`): "" clears; `matched` = installments recognised now. */
export const patchLoanPayment = (slug: string, id: number, body: { text?: string | null; iban?: string | null }) =>
  jpatch<{ loan: LoanInfo; matched: number }>(pp(slug, `/loans/${id}/payment`), body);
