// Manual assets and vehicles (F7 merge, design/v2/networth-merge): a vehicle's monthly loss and value
// curve, the valuation date line, the rate in percent and the assets first steps. Pure; tested in
// src/testing/assets.test.mjs.

import { intlLocale, lang, normalizeNumberInput } from "@cashu/i18n";
import { S } from "./logic.strings.js";

/** A vehicle's depreciation terms on its GET /assets/manual row (contract F7-merge: `annual_rate` is a
 * fraction, 0.15 = 15 % / yr; `floor` the value it never drops below). */
export interface Depreciation {
  purchase_price: number;
  purchase_date: string;
  annual_rate: number;
  floor: number | null;
}

/** Monthly declining-balance loss at `value`: value * (1 - (1 - rate) ** (1/12)), never past the floor (0 at or
 * below it); null without terms or value. */
export function monthlyLoss(
  value: number | null | undefined,
  dep: Depreciation | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value) || !dep || !Number.isFinite(dep.annual_rate))
    return null;
  const floor = dep.floor ?? null;
  if (floor != null && value <= floor) return 0;
  const rate = Math.min(1, Math.max(0, dep.annual_rate));
  const loss = value * (1 - (1 - rate) ** (1 / 12));
  return floor != null ? Math.min(loss, value - floor) : loss;
}

/** "15" / "12,5" (percent per year) of a fraction rate. */
export const ratePct = (rate: number): string =>
  (rate * 100).toLocaleString(intlLocale(), { maximumFractionDigits: 1 });

const dayNo = (iso: string) =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) /
  86400000;

/** A calendar day in English ("Sep 1" / "Sep 1, 2026"). */
const enDay = (iso: string, year: boolean): string =>
  new Intl.DateTimeFormat(intlLocale(), {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))),
  );

/** "1.09.2026" of "2026-09-01" (English: "Sep 1, 2026"). */
export const dmy = (iso: string): string =>
  lang() === "pl"
    ? `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
    : enDay(iso, true);

/** "wycena 1.09" (same year as `today`) / "wycena 3.03.2025"; stale = older than 365 days. null without a date. */
export function valuationLabel(
  asOf: string | null | undefined,
  today: string,
): { text: string; stale: boolean } | null {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}/.test(asOf)) return null;
  const d = asOf.slice(0, 10);
  const sameYear = d.slice(0, 4) === today.slice(0, 4);
  const text = S.valuation(
    sameYear
      ? lang() === "pl"
        ? `${Number(d.slice(8, 10))}.${d.slice(5, 7)}`
        : enDay(d, false)
      : dmy(d),
  );
  return { text, stale: dayNo(today) - dayNo(d) > 365 };
}

/** Polish-typed amount ("545 000", "1234,50") -> number >= 0, else null. */
export function parseValue(text: string): number | null {
  const t = normalizeNumberInput(text);
  if (!t || !/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A vehicle's depreciation fields as typed: price, purchase date, yearly rate in percent, optional floor. */
export interface CurveDraft {
  price: string;
  purchaseDate: string;
  ratePct: string;
  floor: string;
}

/** The curve as the API takes it (`annual_rate` a fraction), or the first problem. */
export function curveBody(
  c: CurveDraft,
  today?: string,
): { ok: true; body: Depreciation } | { ok: false; error: string } {
  const price = parseValue(c.price);
  if (price == null || !(price > 0)) return { ok: false, error: S.price };
  const date = c.purchaseDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: S.purchaseDate };
  if (today && date > today) return { ok: false, error: S.purchaseFuture };
  const rate = parseValue(c.ratePct);
  if (rate == null || rate < 0 || rate > 100) return { ok: false, error: S.rate };
  const floor = c.floor.trim() ? parseValue(c.floor) : null;
  if (c.floor.trim() && floor == null) return { ok: false, error: S.floorInvalid };
  if (floor != null && floor > price) return { ok: false, error: S.floorAbovePrice };
  return {
    ok: true,
    body: {
      purchase_price: price,
      purchase_date: date,
      annual_rate: Math.round(rate * 1e6) / 1e8,
      floor,
    },
  };
}

/** A vehicle's value on `today` by the declining-balance curve (modules/assets/depreciation.py): 0 before the
 * purchase, `price * (1 - rate) ** years` (years = days / 365.25), never below `floor`. */
export function vehicleValue(
  price: number,
  purchaseDate: string,
  ratePct: number,
  floor: number | null,
  today: string,
): number {
  if (!/^\d{4}-\d{2}-\d{2}/.test(purchaseDate) || !/^\d{4}-\d{2}-\d{2}/.test(today)) return price;
  const days = dayNo(today) - dayNo(purchaseDate);
  if (days < 0) return 0;
  const v = price * (1 - ratePct / 100) ** (days / 365.25);
  return floor != null ? Math.max(v, floor) : v;
}

/** The live line under the curve fields: `dziś ≈ 63 391 zł · -853 zł / mies.` as numbers, or null while invalid. */
export function curvePreview(c: CurveDraft, today: string): { value: number; loss: number } | null {
  const r = curveBody(c, today);
  if (!r.ok) return null;
  const d = r.body;
  const value = vehicleValue(
    d.purchase_price,
    d.purchase_date,
    d.annual_rate * 100,
    d.floor,
    today,
  );
  return { value, loss: monthlyLoss(value, d) ?? 0 };
}

/** The assets first steps' statuses from the rows (first-steps section 10): a position (done with any row), a
 * vehicle with its curve (optional: done only when one exists). */
export function assetSteps(
  rows: readonly { kind?: string | null; type?: string; depreciation?: Depreciation | null }[],
): { position: "done" | "on"; vehicle: "done" | "todo" } {
  const vehicles = rows.filter(
    (r) => (r.kind === "vehicle" || r.type === "vehicle") && r.depreciation,
  );
  return { position: rows.length ? "done" : "on", vehicle: vehicles.length ? "done" : "todo" };
}
