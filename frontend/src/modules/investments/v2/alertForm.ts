// Alert form round trip (F7 FE4 / FE12): the edit form shows the stored values without rounding them, builds
// the params from the typed text, and an edit PATCHes only what the owner changed: an untouched level,
// threshold, cooldown ("bez pauzy" included) or expiry goes back exactly as stored (or is not sent at all).
// The kind never changes by PATCH (the backend has no `kind` in AlertPatchBody), so the weight direction is
// fixed while editing. Pure; tested in tests/alertform.test.mjs.
import { localDay } from "../../../time.ts";

const fmt = (v: number, maxDigits: number, minDigits: number) =>
  v.toLocaleString("pl-PL", { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits, useGrouping: false });

/** A price level as input text without losing digits: 4.3175 -> "4,3175", 140 -> "140,00". */
export function levelText(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? fmt(v, 8, 2) : "";
}

/** A fraction as percent input text without losing digits: 0.0625 -> "6,25", 0.3 -> "30". */
export function percentText(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  return fmt(Number((v * 100).toPrecision(12)), 8, 0);
}

/** The texts of the form's param fields. */
export interface AlertDraftText {
  level: string; threshold: string; windowDays: string; direction: string; expression: string; bucket: string;
  /** range_breakout: the narrow range's maximum width in percent ("8"; stored as the fraction 0.08, F8 BE C3);
   * volume_spike: the multiple ("2,5"). */
  rangePct?: string; multiple?: string;
}

/** A plain number as input text: 2.5 -> "2,5", 8 -> "8". */
const plainText = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? fmt(v, 8, 0) : "");

export function draftText(params: Record<string, unknown> | null | undefined, defaultBucket = ""): AlertDraftText {
  const p = params ?? {};
  return {
    level: levelText(p.level),
    threshold: percentText(p.threshold),
    windowDays: typeof p.window_days === "number" ? String(p.window_days) : "",
    direction: p.direction == null ? "" : String(p.direction),
    expression: p.expression == null ? "" : String(p.expression),
    bucket: p.bucket == null ? defaultBucket : String(p.bucket),
    rangePct: percentText(p.max_range_pct),
    multiple: plainText(p.multiple),
  };
}

/** Polish-typed number ("1 234,56", "148.60") -> number | null. */
function num(text: string): number | null {
  const t = text.replace(/[\s ]/g, "").replace(",", ".");
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Params of `kind` built from the form texts (percent fields become fractions). */
export function buildParams(kind: string, scope: string, t: AlertDraftText): Record<string, unknown> {
  const lv = num(t.level), th = num(t.threshold), wd = t.windowDays ? Number(t.windowDays) : null;
  const frac = th != null ? Number((th / 100).toPrecision(12)) : null;
  switch (kind) {
    case "price_above": case "price_below": return { level: lv };
    case "change_pct": return { window_days: wd, threshold: frac, direction: t.direction || "any" };
    case "drawdown_from_high": return { window_days: wd ?? 252, threshold: frac };
    case "new_high": return { window_days: wd ?? 252 };
    case "sma_cross": return { window_days: wd ?? 200, direction: t.direction || "below" };
    case "weight_above": case "weight_below": return { threshold: frac, ...(scope === "bucket" ? { bucket: t.bucket } : {}) };
    case "range_breakout": {
      const r = num(t.rangePct ?? "");
      return { window_days: wd ?? 30, max_range_pct: r != null ? Number((r / 100).toPrecision(12)) : null, direction: t.direction || "any" };
    }
    case "volume_spike": return { window_days: wd ?? 20, multiple: num(t.multiple ?? "") };
    default: return { expression: t.expression.trim(), ...(scope === "bucket" ? { bucket: t.bucket } : {}) };
  }
}

/** Deep equality, insensitive to key order (F7 fix pass F7); undefined and null are the same. */
export function same(a: unknown, b: unknown): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!same(ra[k], rb[k])) return false;
  return true;
}

/** Params to save for an edit: a value the owner did not touch (its text-built value equals the one built
 * from the initial texts) keeps the stored value; a default the form filled for a key the stored params lack
 * (e.g. `direction: "any"`) is not added while untouched (the backend fills it the same way). Returns null
 * when nothing changed, so a note-only edit never re-sends params (F7 fix pass F7). */
export function editedParams(stored: Record<string, unknown>, initial: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    const untouched = same(v, initial[k]);
    if (k in stored) out[k] = untouched ? stored[k] : v;
    else if (!untouched) out[k] = v;
  }
  for (const [k, v] of Object.entries(stored)) if (!(k in out)) out[k] = v; // a param the form does not show stays
  return same(out, stored) ? null : out;
}

/** Initial expiry choice of the form: the local calendar day of the stored expiry, "" = never. */
export const expiryChoice = (expiresAt: string | null | undefined): string => (expiresAt ? localDay(expiresAt) ?? "" : "");

/** The expiry instant of a chosen day: 23:59 local time, sent with its UTC offset (never naive). */
export function expiryValue(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0).toISOString();
}

export interface AlertLike {
  kind: string; title: string; params: Record<string, unknown>; polarity: string; severity: string;
  note: string | null; cooldown_days: number | null; expires_at: string | null;
}

export interface AlertFormValues {
  title: string; params: Record<string, unknown>; initialParams: Record<string, unknown>; polarity: string; severity: string;
  note: string | null; cooldown_days: number | null; expiry: string;
}

/** The PATCH body of an edit: only the fields that differ from the stored alert (an empty object = no change).
 * Never carries kind, scope or instrument (the backend keeps them). */
export function alertPatch(a: AlertLike, v: AlertFormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v.title !== a.title) out.title = v.title;
  const params = editedParams(a.params, v.initialParams, v.params);
  if (params) out.params = params;
  if (v.polarity !== a.polarity) out.polarity = v.polarity;
  if (v.severity !== a.severity) out.severity = v.severity;
  if ((v.note ?? null) !== (a.note ?? null)) out.note = v.note;
  if ((v.cooldown_days ?? null) !== (a.cooldown_days ?? null)) out.cooldown_days = v.cooldown_days;
  if (v.expiry !== expiryChoice(a.expires_at)) out.expires_at = v.expiry ? expiryValue(v.expiry) : null;
  return out;
}

/** The kind of an alert form: in edit mode the stored kind (the direction of a weight alert is fixed). */
export function formKind(card: string, above: boolean, stored: string | null): string {
  if (stored) return stored;
  return card === "weight" ? (above ? "weight_above" : "weight_below") : card;
}

/** Client-side checks before the server's catalog validation (Polish messages). */
export function validate(kind: string, scope: string, params: Record<string, unknown>, inst: object | null, bucket: string): string[] {
  const out: string[] = [];
  if (scope === "instrument" && !inst) out.push("Wybierz instrument z listy.");
  if (scope === "bucket" && !bucket) out.push("Wybierz koszyk.");
  const num = (k: string) => (typeof params[k] === "number" && Number.isFinite(params[k] as number) ? (params[k] as number) : null);
  if ((kind === "price_above" || kind === "price_below") && !(num("level")! > 0)) out.push("Podaj poziom ceny większy od zera.");
  if ("window_days" in params) {
    // The catalog wants at least 2 sessions for drawdown / new high / SMA (alerts/catalog.py), 1 for a change.
    const w = num("window_days"), min = kind === "change_pct" ? 1 : kind === "range_breakout" ? 10 : kind === "volume_spike" ? 5 : 2;
    if (w == null || w < min || w > 260 || !Number.isInteger(w)) out.push(`Okno: liczba sesji od ${min} do 260.`);
  }
  if (kind === "change_pct" && !(num("threshold")! > 0)) out.push("Podaj próg zmiany w procentach.");
  if (kind === "drawdown_from_high" && !(num("threshold")! > 0 && num("threshold")! < 1)) out.push("Próg spadku: od 0 do 100 %.");
  if ((kind === "weight_above" || kind === "weight_below") && !(num("threshold")! > 0 && num("threshold")! <= 1)) out.push("Próg wagi: od 0 do 100 % portfela.");
  if (kind === "custom" && !String(params.expression ?? "").trim()) out.push("Wpisz wyrażenie.");
  if (kind === "range_breakout" && !(num("max_range_pct")! >= 0.01 - 1e-12 && num("max_range_pct")! <= 0.3 + 1e-12)) out.push("Zakres maks.: od 1 do 30 %.");
  if (kind === "volume_spike" && !(num("multiple")! >= 1.5 && num("multiple")! <= 20)) out.push("Krotność: od 1,5 do 20.");
  return out;
}
