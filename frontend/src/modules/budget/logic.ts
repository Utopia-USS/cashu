// Pure helpers of the budget module (no React, no DOM): currency choice, months, the month-close
// view and the cushion form. Tested in tests/budget.test.mjs.
import type { BudgetCurrencies, CushionSettings, InvestingLink, MonthClose, StatementCommit, StatementRow } from "./api";
import type { Account } from "../../core/api";
import { plural } from "../../format.ts";
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

// ---- first steps: statement import (design/v3/first-steps sections 3, 4) ------------------------------------

/** The `Bank` select when the server has no GET /budget/import/importers (an older server): `[id, label]`. The list
 * itself comes from that endpoint (institutions.csv_ids() + the cashU format). "auto" = detect from the file. */
export const BANKS: [string, string][] = [["auto", "rozpoznaj automatycznie"], ["mbank", "mBank"], ["pekao", "Bank Pekao"], ["erste", "Erste Bank Polska"]];
/** Account types a statement can create, `[id, label]` (format.ts TYPE_LABEL). */
export const STATEMENT_TYPES: [string, string][] = [["checking", "Konta osobiste"], ["savings", "Oszczędności"], ["credit", "Karty kredytowe"]];

/** "mBank" of "mbank" (from `choices`, the importer list, else the fallback list); an unknown id as it is. */
export const bankName = (id: string | null | undefined, choices?: readonly { id: string; name: string }[] | null): string =>
  choices?.find((c) => c.id === id)?.name ?? BANKS.find(([k]) => k === id)?.[1] ?? id ?? "";

/** The `Bank` select's options from the importer list: auto, banks, formats (connectors are sources of their own,
 * importSources.tsx); unavailable entries dropped; the fallback list without one. */
export function bankOptions(choices: readonly { id: string; name: string; kind: string; available: boolean }[] | null | undefined): [string, string][] {
  if (!choices?.length) return BANKS;
  const opts = choices.filter((c) => c.available && c.kind !== "connector").map((c) => [c.id, c.name] as [string, string]);
  return opts.some(([k]) => k === "auto") ? opts : [["auto", "rozpoznaj automatycznie"], ...opts];
}

/** Account types a bank statement (or a budget connector) writes to: the budget module's bank types. */
export const BANK_TYPES: ReadonlySet<string> = new Set(STATEMENT_TYPES.map(([k]) => k));
/** The profile's bank accounts: a bank account type (no brokerage, property, loan or cash pool) and not a manual
 * position (a deposit added by hand in Majątek may have the type `savings`). */
export const bankAccounts = <T extends Pick<Account, "bank" | "type">>(accounts: readonly T[]): T[] =>
  accounts.filter((a) => BANK_TYPES.has(a.type) && a.bank !== "manual");

/** "3.10" of "2026-10-03" (day.month, no leading zero on the day). */
export function dmShort(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${Number(m[3])}.${m[2]}` : "-";
}

/** The done hint of the statement step: `mBank · eKonto · …1234 · PLN` per bank account joined with ` · `, then
 * ` · ostatni import 3.10` from the newest balance date. Empty without accounts. */
export function statementDone(
  accounts: readonly Pick<Account, "bank" | "name" | "iban_tail" | "currency" | "as_of">[],
  choices?: readonly { id: string; name: string }[] | null,
): string {
  if (!accounts.length) return "";
  const parts = accounts.map((a) => [bankName(a.bank, choices), a.name, a.iban_tail ? `…${a.iban_tail}` : null, a.currency].filter(Boolean).join(" · "));
  const last = accounts.map((a) => a.as_of).filter((d): d is string => !!d).sort().slice(-1)[0];
  return `${parts.join(" · ")}${last ? ` · ostatni import ${dmShort(last)}` : ""}`;
}

/** The preview table's rows: only the new ones on request, the first `cap` unless `all`; `rest` = hidden rows. */
export function previewRows<T extends Pick<StatementRow, "status">>(rows: readonly T[], onlyNew: boolean, all: boolean, cap = 8): { shown: T[]; rest: number } {
  const list = onlyNew ? rows.filter((r) => r.status === "new") : [...rows];
  const shown = all ? list : list.slice(0, cap);
  return { shown, rest: list.length - shown.length };
}

/** The muted line under `Zaimportowano n transakcji.`. */
export function importDoneLine(d: StatementCommit): string {
  const acc = `konto ${d.account.name}${d.account.iban_tail ? ` …${d.account.iban_tail}` : ""}${d.account.created ? " (nowe)" : ""}`;
  return `${d.duplicates ? `${plural(d.duplicates, "duplikat pominięty", "duplikaty pominięte", "duplikatów pominiętych")} · ` : ""}${acc} · ${d.categorized} skategoryzowanych automatycznie${d.transfer_pairs ? ` · ${plural(d.transfer_pairs, "para", "pary", "par")} przelewów` : ""}`;
}

/** Which field a statement upload error belongs to, and its message key: `import.bank_unknown` (or the header form
 * `import_bank_unknown`) -> the bank select; 413 -> `error.file_too_large`. Returns the label key to look up
 * (core/messages.ts) or null for the server's own text. */
export function statementErrorKey(e: { status?: unknown; code?: unknown }): { key: string | null; field: "bank" | "file" | null } {
  if (e.status === 413) return { key: "error.file_too_large", field: "file" };
  const code = typeof e.code === "string" ? e.code.replace(/^error\./, "").replace(/\./g, "_") : "";
  if (!code) return { key: null, field: null };
  return { key: `error.${code}`, field: code === "import_bank_unknown" ? "bank" : null };
}

/** The CLI prefix for command lines in the app: the setup response's `cli_prefix`, else read off a step's `cli`
 * action (`cashu --profile jan import-csv WYCIAG.csv` -> `cashu --profile jan`), else the plain default. */
export function cliPrefix(info: { cli_prefix?: string | null; steps?: { actions?: { kind: string; target: string }[] }[] } | null, slug: string): string {
  if (info?.cli_prefix) return info.cli_prefix;
  for (const s of info?.steps ?? []) {
    for (const a of s.actions ?? []) {
      const m = /^(.*?--profile \S+)\s/.exec(a.target);
      if (a.kind === "cli" && m) return m[1];
    }
  }
  return `cashu --profile ${slug}`;
}

/** The bank part of the tabbar `↻ Synchronizuj` toast (POST /resync). A profile with connector bindings but no
 * Enable Banking session gets `banks: []` and its connector lines only (null here). */
export function resyncBankText(r: { ok: boolean; error?: string; inserted?: number; banks?: unknown[]; pairs?: number; errors?: string[]; connectors?: unknown[] }): string | null {
  if (!r.ok) return r.error || "Synchronizacja nieudana";
  if (r.connectors?.length && !r.banks?.length) return null;
  let msg = `Wgrano ${r.inserted ?? 0} nowych transakcji`;
  if (r.pairs) msg += `, ${r.pairs} przelewów wewn.`;
  if (r.errors?.length) msg += ` · ${r.errors.length} konto/a pominięte (limit banku)`;
  return msg;
}
