// Typed client over the FastAPI /api/* backend. No business logic here — just
// transport + shapes mirroring the JSON the server returns.

// Per-launch API token: `finanse serve` injects it into index.html as
// <meta name="finanse-token">. Absent under `npm run dev`, where the Vite proxy
// adds the header itself (see vite.config.ts).
const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="finanse-token"]')?.content ?? "";
const auth: Record<string, string> = TOKEN ? { "X-Finanse-Token": TOKEN } : {};

export const j = async <T>(u: string): Promise<T> => {
  const r = await fetch(u, { headers: auth });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.json() as Promise<T>;
};

export const jpost = async <T>(u: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.json() as Promise<T>;
};

export const jdel = async <T>(u: string): Promise<T> => {
  const r = await fetch(u, { method: "DELETE", headers: auth });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.json() as Promise<T>;
};

// ---- shapes ----------------------------------------------------------------
export interface Breakdown {
  currency: string;
  assets: number;
  liabilities: number;
  net: number;
  property: number;
  mortgage: number;
  home_equity: number;
  by_type: Record<string, number>;
}

export interface Account {
  id: number;
  bank: string;
  name: string;
  type: string;
  currency: string;
  iban_tail: string;
  balance: number | null;
  as_of: string | null;
  is_liability: boolean;
}

export interface Summary {
  networth: Record<string, number>;
  breakdown: Breakdown;
  month: { label: string; income: number; expense: number; net: number } | null;
  subscriptions: { count: number; monthly_total: number };
}

export interface NetworthResp {
  totals: Record<string, number>;
  breakdown: Breakdown;
  accounts: Account[];
}

export interface SeriesPoint { date: string; value: number; components: Record<string, number> }
export interface SeriesComponent { key: string; label: string; liability: boolean }
export interface SeriesResp { points: SeriesPoint[]; components: SeriesComponent[] }
export interface CashflowRow { label: string; income: number; expense: number; net: number }
export interface Category { key: string; label: string; kind: string }
export interface SpendRow { category: string; label: string; amount: number }

export interface DrillRow {
  id: number;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  merchant_key: string;
  details: string | null;
  counterparty: string | null;
  category: string;
  category_source: string | null;
  account: string | null;
}

export interface RecurringItem {
  payee: string; amount: number; count: number; gap_days: number; last: string; active: boolean;
}

export interface CashTxn {
  id: number;
  date: string;
  amount: number;
  title: string;
  category: string;
  category_label: string;
  kind: "withdrawal" | "expense";
}

export interface CashResp {
  exists: boolean;
  account_id?: number;
  currency: string;
  balance: number;
  withdrawals: number;
  expenses: number;
  transactions: CashTxn[];
}

export interface ResyncResp {
  ok: boolean;
  error?: string;
  inserted?: number;
  banks?: { bank: string; inserted: number; accounts: number }[];
  pairs?: number;
  errors?: string[];
}

export interface LoanInfo {
  has_loan: boolean;
  currency?: string;
  monthly_payment?: number;
  outstanding?: number;
  total_interest?: number;
  paid_interest?: number;
  payoff_date?: string;
  months_elapsed?: number;
  series?: { date: string; balance: number }[];
  schedule?: { n: number; date: string; payment: number; interest: number; principal: number; balance: number }[];
}

// ---- endpoints -------------------------------------------------------------
export const getSummary = () => j<Summary>("/api/summary");
export const getNetworth = () => j<NetworthResp>("/api/networth");
export const getSeries = (granularity: string, scope: string) =>
  j<SeriesResp>(`/api/networth/series?granularity=${granularity}&scope=${scope}`);
export const getCashflow = (months = 240) => j<CashflowRow[]>(`/api/cashflow?months=${months}`);
export const getRecurring = () => j<{ items: RecurringItem[] }>("/api/recurring");
export const getSpending = (q: string) => j<SpendRow[]>("/api/spending" + q);
export const getCash = () => j<CashResp>("/api/cash");
export const getLoan = () => j<LoanInfo>("/api/loan");

export const postTxnCategory = (id: number, category: string) =>
  jpost<{ ok: boolean }>(`/api/transactions/${id}/category`, { category });
export const postMerchantCategory = (merchant_key: string, category: string) =>
  jpost<{ updated: number }>("/api/merchant-category", { merchant_key, category });
export const postCashExpense = (b: { amount: number; title: string; category: string }) =>
  jpost<{ ok?: boolean; id?: number; error?: string }>("/api/cash/expense", b);
export const deleteCashTxn = (id: number) => jdel<{ ok: boolean }>(`/api/cash/transaction/${id}`);
export const postResync = () => jpost<ResyncResp>("/api/resync");

export const drillUrl = (
  key: string,
  opts: { sort: string; order: string; year?: number | null; month?: number | null; quarter?: number | null },
): string => {
  const p = new URLSearchParams({ sort: opts.sort, order: opts.order, currency: "PLN" });
  if (opts.year) p.set("year", String(opts.year));
  if (opts.month) p.set("month", String(opts.month));
  if (opts.quarter) p.set("quarter", String(opts.quarter));
  return `/api/category/${encodeURIComponent(key)}/transactions?${p.toString()}`;
};

// categories are static for a session — fetch once, memoized.
let _cats: Promise<Category[]> | null = null;
export const getCategories = (): Promise<Category[]> => (_cats ??= j<Category[]>("/api/categories"));
