// Budget module endpoints (profile-scoped). Shapes mirror the server JSON.
import { j, jpost, pp } from "../../core/api";

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

export const getCashflow = (slug: string, months = 240) => j<CashflowRow[]>(pp(slug, `/cashflow?months=${months}`));
export const getRecurring = (slug: string) => j<{ items: RecurringItem[] }>(pp(slug, "/recurring"));
export const getSpending = (slug: string, q: string) => j<SpendRow[]>(pp(slug, "/spending" + q));

export const postTxnCategory = (slug: string, id: number, category: string) =>
  jpost<{ ok: boolean }>(pp(slug, `/transactions/${id}/category`), { category });
export const postMerchantCategory = (slug: string, merchant_key: string, category: string) =>
  jpost<{ updated: number }>(pp(slug, "/merchant-category"), { merchant_key, category });

export const drillUrl = (
  slug: string,
  key: string,
  opts: { sort: string; order: string; year?: number | null; month?: number | null; quarter?: number | null },
): string => {
  const p = new URLSearchParams({ sort: opts.sort, order: opts.order, currency: "PLN" });
  if (opts.year) p.set("year", String(opts.year));
  if (opts.month) p.set("month", String(opts.month));
  if (opts.quarter) p.set("quarter", String(opts.quarter));
  return pp(slug, `/category/${encodeURIComponent(key)}/transactions?${p.toString()}`);
};
