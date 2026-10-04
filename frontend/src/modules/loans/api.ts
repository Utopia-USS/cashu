// Loans module endpoints (profile-scoped). One profile can hold many loans.
import { ApiError, j, pp } from "../../core/api";

export interface LoanInfo {
  // Identity of a list item; the contract keeps the upstream /loan shape per item,
  // so every field here is optional and the UI falls back gracefully.
  id?: number;
  name?: string;
  account?: string;
  has_loan?: boolean;
  currency?: string;
  principal?: number;
  annual_rate?: number;
  monthly_payment?: number;
  outstanding?: number;
  total_interest?: number;
  paid_interest?: number;
  payoff_date?: string;
  months_elapsed?: number;
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
