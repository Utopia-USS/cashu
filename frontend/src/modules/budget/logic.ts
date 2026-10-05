// Pure helpers of the budget module (no React, no DOM): currency choice, months, the month-close
// view and the cushion form. Tested in tests/budget.test.mjs.
import type { BudgetCurrencies, CushionSettings, InvestingLink, MonthClose } from "./api";
import { ck, invalidate } from "../../swr.ts";

// ---- cached views a budget write makes stale (F7 FIX2 B1 / B2; src/swr.ts) ---------------------------------
/** The month close is cached under the card's keys (`budget/monthclose-card/<month>`) and the Przegląd widgets'
 * keys (`budget/monthclose/<month>`: the budget widget and the surplus card). Also stale after a strategy write
 * (its `investing` part is the contribution plan). */
export function monthCloseStale(slug: string): void {
  invalidate(ck(slug, "budget", "monthclose"));
  invalidate(ck(slug, "budget", "monthclose-card"));
}
/** A cushion save: the cushion top-up and the transfer of every month close, and the budget views around them. */
export function cushionSaved(slug: string): void {
  invalidate(ck(slug, "budget"));
}
/** A transaction's category change: the budget views and the cash pool (it counts "Wypłata gotówki"). */
export function recategorized(slug: string): void {
  invalidate(ck(slug, "budget"));
  invalidate(ck(slug, "cash"));
}

export const MPL = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

/** "2026-09" -> "wrz 2026". */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m ? `${MPL[m - 1]} ${y}` : ym;
}

/** "2026-09" shifted by `delta` months -> "2026-10". */
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** The currency to show: the remembered one when the profile still has data in it, else the server's
 * default (base currency when it has data, else the most used one), else the base currency. */
export function pickCurrency(remembered: string | null | undefined, info: BudgetCurrencies | null): string | null {
  if (!info) return null;
  const codes = info.currencies.map((c) => c.currency);
  if (remembered && codes.includes(remembered)) return remembered;
  return codes.length ? info.default : info.base;
}

/** The month-close figures of `currency`, plus the other currencies with data that month. */
export function closeFor(close: MonthClose, currency: string | null) {
  const main = close.currencies.find((c) => c.currency === currency) ?? null;
  const others = close.currencies.filter((c) => c.currency !== currency);
  return { main, others };
}

export type PlanState =
  | { kind: "off" }
  | { kind: "no_plan"; strategy: string | null }
  | { kind: "covered" | "short"; planned: number; currency: string; suggested: number; difference: number; hasData: boolean };

/** How the suggested transfer compares with the strategy's planned monthly contribution. */
export function planState(inv: InvestingLink | null): PlanState {
  if (!inv) return { kind: "off" };
  if (!inv.planned || !inv.comparison) return { kind: "no_plan", strategy: inv.strategy_state };
  const c = inv.comparison;
  return {
    kind: c.status, planned: inv.planned.amount, currency: inv.planned.currency,
    suggested: c.suggested_transfer, difference: c.difference, hasData: c.has_data,
  };
}

// ---- cushion form ---------------------------------------------------------------------------------
export interface CushionDraft {
  enabled: boolean;
  mode: "amount" | "months";
  amount: string;
  months: string;
  currency: string;
  accountIds: number[];
  monthlyMax: string;
}

export function cushionDraft(s: CushionSettings, baseCurrency: string): CushionDraft {
  return {
    enabled: s.enabled,
    mode: s.target_amount == null && s.target_months != null ? "months" : "amount",
    amount: s.target_amount == null ? "" : String(s.target_amount),
    months: s.target_months == null ? "6" : String(s.target_months),
    currency: s.currency ?? baseCurrency,
    accountIds: [...s.account_ids],
    monthlyMax: s.monthly_max == null ? "" : String(s.monthly_max),
  };
}

const num = (v: string): number | null => {
  const t = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/** The settings payload of a draft, or a Polish validation message (the server checks again). */
export function cushionPayload(d: CushionDraft, baseCurrency: string): { ok: true; value: CushionSettings } | { ok: false; error: string } {
  const amount = num(d.amount), months = num(d.months), max = num(d.monthlyMax);
  if (d.enabled) {
    if (d.mode === "amount" && (amount == null || Number.isNaN(amount) || amount <= 0)) return { ok: false, error: "Podaj kwotę większą od zera." };
    if (d.mode === "months" && (months == null || !Number.isInteger(months) || months < 1 || months > 36)) return { ok: false, error: "Liczba miesięcy: od 1 do 36." };
  }
  if (max != null && (Number.isNaN(max) || max <= 0)) return { ok: false, error: "Maks. dopłata: liczba większa od zera albo puste." };
  const okAmount = amount != null && !Number.isNaN(amount) && amount > 0 ? amount : null;
  const okMonths = months != null && Number.isInteger(months) && months >= 1 && months <= 36 ? months : null;
  return {
    ok: true,
    value: {
      enabled: d.enabled,
      currency: d.currency && d.currency !== baseCurrency ? d.currency : null,
      target_amount: d.mode === "amount" ? okAmount : null,
      target_months: d.mode === "months" ? okMonths : null,
      account_ids: d.accountIds,
      monthly_max: max == null || Number.isNaN(max) ? null : max,
    },
  };
}
