// Budget module endpoints (profile-scoped). Shapes mirror the server JSON. Every view takes an
// explicit currency (the server defaults to the profile's base currency, never sums currencies).
import { j, jpost, jput, jupload, pp } from "../../core/api";

export interface CashflowRow { label: string; income: number; expense: number; net: number }
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
  payee: string; amount: number; currency: string; count: number; gap_days: number; last: string; active: boolean;
}

const withCurrency = (q: string, currency?: string | null) =>
  currency ? `${q}${q.includes("?") ? "&" : "?"}currency=${encodeURIComponent(currency)}` : q;

export const getCashflow = (slug: string, months = 240, currency?: string | null) =>
  j<CashflowRow[]>(pp(slug, withCurrency(`/cashflow?months=${months}`, currency)));
export const getRecurring = (slug: string) => j<{ items: RecurringItem[] }>(pp(slug, "/recurring"));
export const getSpending = (slug: string, q: string, currency?: string | null) =>
  j<SpendRow[]>(pp(slug, withCurrency("/spending" + q, currency)));

// ---- currencies, month close, budget settings --------------------------------------------------
export interface CurrencyUse { currency: string; transactions: number; first: string; last: string }
/** `default`: the base currency when it has data, else the most used one (the picker's start). */
export interface BudgetCurrencies { base: string; default: string; currencies: CurrencyUse[] }

export interface CategoryAmount { category: string; label: string; amount: number }
export interface CurrencyClose {
  currency: string;
  income: number;
  spending: number;
  surplus: number;
  cushion_top_up: number;
  suggested_transfer: number;
  transactions: number;
  income_by_category: CategoryAmount[];
  spending_by_category: CategoryAmount[];
}
export interface CushionState {
  enabled: boolean;
  currency: string;
  target: number | null;
  target_source: "amount" | "months";
  target_months: number | null;
  average_spending: number | null;
  balance: number;
  missing: number;
  top_up: number;
  reached: boolean;
  accounts: { id: number; name: string }[];
}
export interface InvestingLink {
  enabled: boolean;
  /** missing | valid | partial | invalid (investments strategy files). */
  strategy_state: string | null;
  planned: { amount: number; currency: string; day_of_month: number | null } | null;
  comparison: {
    currency: string;
    has_data: boolean;
    surplus: number;
    suggested_transfer: number;
    difference: number;
    status: "covered" | "short";
  } | null;
}
export interface MonthClose {
  month: string;
  complete: boolean;
  base_currency: string;
  first_month: string | null;
  last_month: string | null;
  currencies: CurrencyClose[];
  cushion: CushionState | null;
  /** null when the investments module is off for the profile. */
  investing: InvestingLink | null;
}
export interface CushionSettings {
  enabled: boolean;
  currency: string | null;
  target_amount: number | null;
  target_months: number | null;
  account_ids: number[];
  monthly_max: number | null;
}
export interface BudgetSettings { cushion: CushionSettings }

export const getBudgetCurrencies = (slug: string) => j<BudgetCurrencies>(pp(slug, "/budget/currencies"));
export const getMonthClose = (slug: string, month?: string | null) =>
  j<MonthClose>(pp(slug, `/budget/month-close${month ? `?month=${encodeURIComponent(month)}` : ""}`));
export const getBudgetSettings = (slug: string) => j<BudgetSettings>(pp(slug, "/budget/settings"));
export const putBudgetSettings = (slug: string, body: BudgetSettings) =>
  jput<BudgetSettings>(pp(slug, "/budget/settings"), body);

export const postTxnCategory = (slug: string, id: number, category: string) =>
  jpost<{ ok: boolean }>(pp(slug, `/transactions/${id}/category`), { category });
export const postMerchantCategory = (slug: string, merchant_key: string, category: string) =>
  jpost<{ updated: number }>(pp(slug, "/merchant-category"), { merchant_key, category });

export const drillUrl = (
  slug: string,
  key: string,
  opts: { sort: string; order: string; currency: string; year?: number | null; month?: number | null; quarter?: number | null },
): string => {
  const p = new URLSearchParams({ sort: opts.sort, order: opts.order, currency: opts.currency });
  if (opts.year) p.set("year", String(opts.year));
  if (opts.month) p.set("month", String(opts.month));
  if (opts.quarter) p.set("quarter", String(opts.quarter));
  return pp(slug, `/category/${encodeURIComponent(key)}/transactions?${p.toString()}`);
};

// ---- first steps: statement import, merchants without a category, transfer matching (first-steps 15 B2-B5) ----
/** POST /budget/import/preview: the parsed statement before anything is written. */
export interface StatementPreview {
  /** sha256 of the staged bytes: the commit's handle. */
  file_id: string;
  file_name: string;
  bank: { id: string; name: string; detected: boolean };
  /** `bank.id` is the importer id (send it back on commit); the account's bank is `account.institution`. */
  account: {
    existing: boolean; id: number | null; name: string; currency: string; iban_tail: string | null; transactions: number;
    institution?: { id: string; name: string } | null;
  };
  /** `overlap` (BE-1, part of `duplicates`): rows not matched one to one but covered by the account's history from
   * another source (bank CSV, Open Banking); skipped. */
  counts: { rows: number; new: number; duplicates: number; skipped: number; overlap?: number };
  range: { from: string; to: string } | null;
  balances?: number;
  /** The first rows (50 at most). */
  rows: StatementRow[];
  /** Newest first; `same_file`: the same bytes (sha256), else only the same file name (e.g. a CLI import). */
  previous_imports: { at: string; file_name: string; inserted: number; same_file?: boolean }[];
  /** finanse format only: non-blocking issues (`import.<kind>` codes). */
  warnings?: { kind: string; code?: string; row: number | null; field?: string | null; message: string; blocking?: boolean }[];
}
export interface StatementRow {
  row: number; date: string; amount: number; currency: string; title: string | null; counterparty: string | null; status: "new" | "duplicate";
  /** A duplicate by the cross-source rule (BE-1). */
  overlap?: boolean;
}
/** POST /budget/import/commit. */
export interface StatementCommit {
  batch_id: number | null;
  account: { id: number; name: string; currency: string; iban_tail: string | null; created: boolean };
  inserted: number;
  duplicates: number;
  skipped: number;
  balances?: number;
  categorized: number;
  transfer_pairs: number;
}
export interface StatementFileInput { file: File; bank: string; account_type: string; account_name: string }
export interface StatementCommitInput { file_id: string; file_name: string; bank?: string; account_type?: string; account_name?: string }

export async function postStatementPreview(slug: string, b: StatementFileInput): Promise<StatementPreview> {
  const fd = new FormData();
  fd.append("file", b.file, b.file.name);
  if (b.bank && b.bank !== "auto") fd.append("bank", b.bank);
  fd.append("account_type", b.account_type);
  if (b.account_name.trim()) fd.append("account_name", b.account_name.trim());
  return jupload<StatementPreview>(pp(slug, "/budget/import/preview"), fd);
}
/** GET /budget/import/importers: the `Bank` select (auto, the banks with a CSV parser, the finanse format; later
 * connectors) and the upload limit. */
export interface ImporterChoice { id: string; name: string; kind: "auto" | "bank" | "format" | "connector" | string; available: boolean }
export const getImporters = (slug: string) => j<{ importers: ImporterChoice[]; max_bytes: number }>(pp(slug, "/budget/import/importers"));

export const postStatementCommit = (slug: string, b: StatementCommitInput) =>
  jpost<StatementCommit>(pp(slug, "/budget/import/commit"), b);
export const postMatchTransfers = (slug: string, maxDays?: number) =>
  jpost<{ pairs: number }>(pp(slug, "/budget/match-transfers"), maxDays != null ? { max_days: maxDays } : {});

/** GET /uncategorized: expense merchants still in the default category, largest total first (one currency). */
export interface UncategorizedRow { merchant_key: string; sample: string; count: number; total: number; currency: string }
export const getUncategorized = (slug: string, limit = 30, currency?: string | null) =>
  j<UncategorizedRow[]>(pp(slug, withCurrency(`/uncategorized?limit=${limit}`, currency)));
