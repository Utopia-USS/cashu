// Manual asset form (F7 OB5): the note is one line, at most NOTE_MAX characters (the backend folds
// whitespace the same way and answers 422 beyond the limit); the add form builds the POST body, an edit
// sends only what changed. The Majątek widget on Przegląd (F7 merge, design/v2/networth-merge): which rows
// are assets, a vehicle's monthly loss, the valuation date line, totals per currency. Pure; tested in
// tests/assets.test.mjs.
import type { Account } from "../../core/api";

/** Manually valued assets (property, vehicles, other manual positions): the net-worth rows the widget falls
 * back to on a server without GET /assets/manual. */
export const isAsset = (a: Account) =>
  a.type === "property" || a.type === "vehicle" || (a.bank === "manual" && a.type === "other" && !a.is_liability);

/** A vehicle's depreciation terms on its GET /assets/manual row (contract F7-merge: `annual_rate` is a
 * fraction, 0.15 = 15 % / yr; `floor` the value it never drops below). */
export interface Depreciation { purchase_price: number; purchase_date: string; annual_rate: number; floor: number | null }

/** Monthly declining-balance loss at `value`: value * (1 - (1 - rate) ** (1/12)), never past the floor (0 at or
 * below it); null without terms or value. */
export function monthlyLoss(value: number | null | undefined, dep: Depreciation | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !dep || !Number.isFinite(dep.annual_rate)) return null;
  const floor = dep.floor ?? null;
  if (floor != null && value <= floor) return 0;
  const rate = Math.min(1, Math.max(0, dep.annual_rate));
  const loss = value * (1 - (1 - rate) ** (1 / 12));
  return floor != null ? Math.min(loss, value - floor) : loss;
}

/** "15" / "12,5" (percent per year) of a fraction rate. */
export const ratePct = (rate: number): string => (rate * 100).toLocaleString("pl-PL", { maximumFractionDigits: 1 });

const dayNo = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

/** "1.09.2026" of "2026-09-01". */
export const dmy = (iso: string): string => `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** "wycena 1.09" (same year as `today`) / "wycena 3.03.2025"; stale = older than 365 days. null without a date. */
export function valuationLabel(asOf: string | null | undefined, today: string): { text: string; stale: boolean } | null {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}/.test(asOf)) return null;
  const d = asOf.slice(0, 10);
  const text = d.slice(0, 4) === today.slice(0, 4) ? `wycena ${Number(d.slice(8, 10))}.${d.slice(5, 7)}` : `wycena ${dmy(d)}`;
  return { text, stale: dayNo(today) - dayNo(d) > 365 };
}

/** [currency, total][]: `base` first, then alphabetical; null balances count as 0; never summed across currencies. */
export function sumByCurrency(rows: { balance: number | null; currency: string }[], base: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + (r.balance ?? 0));
  return [...m].sort((a, b) => (a[0] === base ? -1 : b[0] === base ? 1 : a[0].localeCompare(b[0])));
}

/** The first `cap` rows unless `all`. */
export function visibleRows<T>(rows: T[], all: boolean, cap = 5): T[] {
  return all ? rows : rows.slice(0, cap);
}

const FUTURE = "Data wyceny nie może być z przyszłości.";

/** modules/assets/models.NOTE_MAX. */
export const NOTE_MAX = 500;

/** Asset types the add form offers (the API also takes mortgage / loan; liabilities live in Kredyty). */
export const CREATE_TYPES = ["property", "investment", "other"] as const;

/** The note as the backend stores it: whitespace folded to single spaces, blank = null. */
export function cleanNote(text: string | null | undefined): string | null {
  const t = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return t || null;
}

/** Polish-typed amount ("545 000", "1234,50") -> number >= 0, else null. */
export function parseValue(text: string): number | null {
  const t = text.replace(/[\s ]/g, "").replace(",", ".");
  if (!t || !/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** `onDate`: the valuation date (`on_date`, "YYYY-MM-DD"; blank = the server's today). */
export interface AssetDraft { name: string; type: string; value: string; currency: string; note: string; onDate?: string }

/** POST body of the add form, or the first problem in Polish. `today` (todayLocal()) guards the date. */
export function createBody(d: AssetDraft, today?: string): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const name = d.name.split(/\s+/).filter(Boolean).join(" ");
  if (!name) return { ok: false, error: "Podaj nazwę." };
  const value = parseValue(d.value);
  if (value == null) return { ok: false, error: "Podaj wartość (liczba, 0 lub więcej)." };
  const onDate = d.onDate?.trim() || null;
  if (onDate && today && onDate > today) return { ok: false, error: FUTURE };
  const note = cleanNote(d.note);
  if (note && note.length > NOTE_MAX) return { ok: false, error: `Notatka: maks. ${NOTE_MAX} znaków.` };
  const currency = d.currency.trim().toUpperCase();
  return { ok: true, body: { name, type: d.type, value, ...(currency ? { currency } : {}), ...(onDate ? { on_date: onDate } : {}), ...(note ? { note } : {}) } };
}

/** PATCH body of an edit: only the changed note / value (an empty object = nothing to save); `on_date` goes
 * only with a changed value (a date alone changes nothing). */
export function patchBody(
  row: { note: string | null; balance: number | null },
  edit: { note: string; value: string | null; onDate?: string },
  today?: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {};
  const note = cleanNote(edit.note);
  if (note && note.length > NOTE_MAX) return { ok: false, error: `Notatka: maks. ${NOTE_MAX} znaków.` };
  if (note !== (row.note ?? null)) body.note = note;
  if (edit.value != null) {
    const value = parseValue(edit.value);
    if (value == null) return { ok: false, error: "Podaj wartość (liczba, 0 lub więcej)." };
    if (row.balance == null || Math.abs(value - row.balance) > 0.005) {
      const onDate = edit.onDate?.trim() || null;
      if (onDate && today && onDate > today) return { ok: false, error: FUTURE };
      body.value = value;
      if (onDate) body.on_date = onDate;
    }
  }
  return { ok: true, body };
}
