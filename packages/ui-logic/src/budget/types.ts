// Budget payload shapes the shared UI logic reads (they mirror the server JSON; transport in the app's api.ts). Types only.

export interface CategoryAmount {
  category: string;
  label: string;
  amount: number;
}

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

// ---- currencies, month close, budget settings --------------------------------------------------
export interface CurrencyUse {
  currency: string;
  transactions: number;
  first: string;
  last: string;
}

export interface CushionSettings {
  enabled: boolean;
  currency: string | null;
  target_amount: number | null;
  target_months: number | null;
  account_ids: number[];
  monthly_max: number | null;
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

/** POST /budget/import/commit. */
export interface StatementCommit {
  batch_id: number | null;
  account: {
    id: number;
    name: string;
    currency: string;
    iban_tail: string | null;
    created: boolean;
  };
  inserted: number;
  duplicates: number;
  skipped: number;
  balances?: number;
  categorized: number;
  transfer_pairs: number;
}

export interface StatementRow {
  row: number;
  date: string;
  amount: number;
  currency: string;
  title: string | null;
  counterparty: string | null;
  status: "new" | "duplicate";
  /** A duplicate by the cross-source rule (BE-1). */
  overlap?: boolean;
}
