// Labels and number/date formatting of the investments workspace (texts in labels.strings.ts). Pure (no
// React, no DOM), unit-tested by the frontend's `npm test`. UI copy rules: sentence case, regular hyphens only,
// percentages with one decimal (Polish: a space before "%"), percentage points as "pp".

import { intlLocale, lang, normalizeNumberInput } from "@cashu/i18n";
import { cur, GROUP } from "../core/format.js";
import { bananaMoney, hideAmount } from "../core/incognito.js";
import { hmLocal, localIsoDate, serverDate } from "../core/time.js";
import {
  ASSET_CLASS as ASSET_CLASS_C,
  BUCKET_GEN,
  BUCKETS as BUCKETS_C,
  DECISION_ACTION as DECISION_ACTION_C,
  ENTRY_TYPE as ENTRY_TYPE_C,
  REGION as REGION_C,
  S,
  TXN_TYPE as TXN_TYPE_C,
  WEEKDAYS as WEEKDAYS_C,
  WRAPPER as WRAPPER_C,
} from "./labels.strings.js";

const NBSP = " ";
/** The gap before "%": a non-breaking space in Polish, none in English. */
const pctGap = () => (lang() === "pl" ? NBSP : "");

/** Number formatters of the current locale, built once per locale. */
const fmtCache = new Map<string, Intl.NumberFormat>();
function nf(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${intlLocale()}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(intlLocale(), opts);
    fmtCache.set(k, f);
  }
  return f;
}
const num1 = {
  format: (v: number) =>
    nf("num1", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v),
};
const num0 = { format: (v: number) => nf("num0", { maximumFractionDigits: 0 }).format(v) };
const qtyFmt = {
  format: (v: number) => nf("qty", { maximumFractionDigits: 6, ...GROUP }).format(v),
};

/** Fraction -> "21,2 %" (one decimal). `signed` adds "+" to positive values. */
export function pct(v: number | null | undefined, signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  const text = num1.format(Math.abs(p) < 0.05 ? 0 : p);
  return `${signed && p > 0.04 ? "+" : ""}${text}${pctGap()}%`;
}

/** Fraction -> whole percent when exact ("60 %"), else one decimal ("12,5 %"). Targets and limits. */
export function pctTarget(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  return `${Number.isInteger(p) ? num0.format(p) : num1.format(p)}${pctGap()}%`;
}

/** Percentage points -> "+6,2 pp" / "-3,0 pp" / "0,0 pp". */
export function pp(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : ""}${num1.format(r === 0 ? 0 : r)}${NBSP}pp`;
}

/** Money with an explicit sign for gains/changes: "+3 240,15 zł", "-11 600,00 zł". */
export function money(v: number | null | undefined, c = "PLN", signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const text = cur(Math.abs(v) < 0.005 ? 0 : v, c);
  return signed && v >= 0.005 ? `+${text}` : text;
}

/**
 * Money that incognito masks and never puts on the banana scale: an amount next to what makes it
 * computable from public data (a quantity and a price in a form). One such banana value would give the
 * scale away. "+3 240,15 zł" as `money`.
 */
export function plainMoney(v: number | null | undefined, c = "PLN", signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const r = Math.abs(v) < 0.005 ? 0 : v;
  const text = hideAmount(
    new Intl.NumberFormat(intlLocale(), { style: "currency", currency: c, ...GROUP }).format(r),
  );
  return signed && r > 0 ? `+${text}` : text;
}

/**
 * The owner's own per-unit price (average cost, a lot's unit cost, a trade's fill price): "148,60 zł".
 * Masked in incognito and never on the banana scale (one known price would give the scale away).
 */
export const unitPrice = (v: number | null | undefined, c = "PLN"): string => plainMoney(v, c);

/**
 * A public market price (last price, close, 52-week high, a level, an SMA): "148,60 zł". Shown as is in
 * incognito: it says nothing about the owner, and it is never put on the banana scale.
 */
export function marketPrice(v: number | null | undefined, c = "PLN"): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return new Intl.NumberFormat(intlLocale(), { style: "currency", currency: c, ...GROUP }).format(
    Math.abs(v) < 0.005 ? 0 : v,
  );
}

/** Whole money for hints: "11 600 zł". */
export function money0(v: number | null | undefined, c = "PLN", signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const r = Math.round(v) || 0; // no negative zero: -0.3 zł is "0 zł", not "-0 zł" (F7 FE11)
  const text =
    bananaMoney(r, c) ??
    hideAmount(
      new Intl.NumberFormat(intlLocale(), {
        style: "currency",
        currency: c,
        maximumFractionDigits: 0,
        ...GROUP,
      }).format(r),
    );
  return signed && r > 0 ? `+${text}` : text;
}

/** Quantity without trailing zeros: 120, 0,5, 1,234567. */
export const qty = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "-" : hideAmount(qtyFmt.format(v));

/** Parse a typed number ("1 234,56", "148.60"; in English also "1,234.56") -> number | null. */
export function parseNum(text: string): number | null {
  const t = normalizeNumberInput(text);
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Number -> input text in the language's notation (Polish: decimal comma; no grouping). */
export const numInput = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v)
    ? ""
    : lang() === "pl"
      ? v.toFixed(digits).replace(".", ",")
      : v.toFixed(digits);

// ---- dates ---------------------------------------------------------------------
export const WEEKDAYS: Record<string, string> = WEEKDAYS_C;
export const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** "2026-10-03" or a datetime -> local calendar parts (dates are read as calendar days, not UTC). */
export function dateParts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  if (iso.length > 10 && /[T ]\d/.test(iso)) {
    const t = serverDate(iso);
    if (t) return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** English dates through Intl (the Polish ones are hand-built below). */
const enDate = (p: { y: number; m: number; d: number }, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(intlLocale(), opts).format(new Date(p.y, p.m - 1, p.d));

/** "3.10" (day.month, no leading zeros) - prose, tags, hints. English: "Oct 3". */
export function dm(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  if (!p) return "-";
  return lang() === "pl"
    ? `${p.d}.${String(p.m).padStart(2, "0")}`
    : enDate(p, { month: "short", day: "numeric" });
}

/** "12.03.2025". English: "Mar 12, 2025". */
export function dmy(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  if (!p) return "-";
  return lang() === "pl"
    ? `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}`
    : enDate(p, { month: "short", day: "numeric", year: "numeric" });
}

/** "pt 3.10". English: "Fri Oct 3". */
export function wdm(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  if (!p) return "-";
  return `${S.weekdayShort[new Date(p.y, p.m - 1, p.d).getDay()]} ${dm(iso)}`;
}

/** "17:35" from a server datetime (local time; a naive server value is UTC, see time.ts). */
export const hm = hmLocal;

/** Local calendar date "YYYY-MM-DD" of a Date. */
export const isoDate = localIsoDate;

export const nInstruments = (n: number) => S.nInstruments(n);
export const nAccountsInv = (n: number) => S.nAccountsInv(n);
export const nBuckets = (n: number) => S.nBuckets(n);
export const nRules = (n: number) => S.nRules(n);

// ---- domain labels -------------------------------------------------------------
export const TXN_TYPE: Record<string, string> = TXN_TYPE_C;
export const txnType = (t: string) => TXN_TYPE[t] ?? t;

export const ASSET_CLASS: Record<string, string> = ASSET_CLASS_C;
export const assetClass = (v: string | null | undefined) => (v ? (ASSET_CLASS[v] ?? v) : "-");

export const REGION: Record<string, string> = REGION_C;
export const region = (v: string | null | undefined) => (v ? (REGION[v.toLowerCase()] ?? v) : "-");

export const WRAPPER: Record<string, string> = WRAPPER_C;

export interface AccountLike {
  id: number;
  name: string;
  broker?: string;
  broker_name?: string;
  wrapper?: string;
}

/** "DIF · zwykłe"; the account name is added when two accounts share broker and wrapper. */
export function accountLabel(a: AccountLike, all: AccountLike[] = []): string {
  const broker = (a.broker_name || a.broker || a.name).replace(/ Broker$/, "");
  const base = `${broker} · ${WRAPPER[a.wrapper ?? ""] ?? a.wrapper ?? ""}`.replace(/ · $/, "");
  const twins = all.filter(
    (x) => x.id !== a.id && x.broker === a.broker && x.wrapper === a.wrapper,
  );
  return twins.length ? `${base} (${a.name})` : base;
}

/** Strategy bucket id -> label, generic ids only (F7-generic contract: the ids of the shipped strategy
 * templates and plain asset-class ids, mirroring the backend's GENERIC_BUCKET_IDS; case-sensitive). The owner's
 * own buckets (custom ids) are internal knowledge for the agent and never named in the app. */
const BUCKETS: Record<string, string> = BUCKETS_C;
/** Generic bucket ids (see BUCKETS). */
export const GENERIC_BUCKET_IDS: readonly string[] = Object.keys(BUCKETS);
export const isGenericBucket = (id: string | null | undefined): boolean =>
  !!id && Object.keys(BUCKETS).includes(id);
/** Label of a generic bucket id; null for any other id (the caller then renders nothing). */
export function bucketLabel(id: string | null | undefined): string | null {
  return id && isGenericBucket(id) ? (BUCKETS[id] ?? null) : null;
}
/** Genitive of the generic bucket labels ("domyka 1,1 pp Akcji globalnych"; English: the label). */
export const bucketGenitive = (id: string | null | undefined): string | null =>
  id && isGenericBucket(id) ? ((BUCKET_GEN as Record<string, string>)[id] ?? null) : null;
/** The name a bucket shows under: its generic label, else the neutral word ("Koszyk" / "Bucket") without the
 * id, for places that must still say "a bucket" (an allocation row, a weight alert, a custom rule). */
export const bucketDisplayName = (id: string | null | undefined): string =>
  bucketLabel(id) ?? S.bucketFallback;

/** Exchange (MIC) -> the name owners use; other MICs show their code (instrument card, asset header). */
const MIC_NAME: Record<string, string> = {
  XWAR: "GPW",
  XNAS: "Nasdaq",
  XNYS: "NYSE",
  ARCX: "NYSE Arca",
  XETR: "Xetra",
  XFRA: "Frankfurt",
  XLON: "LSE",
  XHKG: "HKEX",
  XAMS: "Euronext Amsterdam",
  XPAR: "Euronext Paris",
  XMIL: "Borsa Italiana",
  XSWX: "SIX",
  XTKS: "TSE",
  BATS: "Cboe",
};
export const micName = (mic: string | null | undefined): string | null =>
  mic ? (MIC_NAME[mic.toUpperCase()] ?? mic) : null;

const BUCKET_COLOR: Record<string, string> = {
  global_equity: "--inv-global",
  global_equities: "--inv-global",
  world_equity: "--inv-global",
  pl_equity: "--inv-pl",
  polish_equity: "--inv-pl",
  pl_equities: "--inv-pl",
  equity_pl: "--inv-pl",
  bonds: "--inv-bonds",
  bond_etfs: "--inv-bonds",
  treasury_bonds: "--inv-bonds",
  pl_bonds: "--inv-bonds",
  cash: "--inv-cash",
};
const SPARE = ["--inv-5", "--inv-6", "--inv-7", "--inv-global", "--inv-pl", "--inv-bonds"];
/** CSS color of a bucket: known ids by token, others by position from spare tokens. */
export function bucketColor(id: string | null | undefined, order: string[] = []): string {
  if (!id) return "var(--inv-other)";
  const known = BUCKET_COLOR[id.toLowerCase()];
  if (known) return `var(${known})`;
  const unknown = order.filter((b) => !BUCKET_COLOR[b.toLowerCase()]);
  const i = Math.max(0, unknown.indexOf(id));
  return `var(${SPARE[i % SPARE.length]})`;
}

export const DECISION_ACTION: Record<string, string> = DECISION_ACTION_C;

export const ENTRY_TYPE: Record<string, string> = ENTRY_TYPE_C;
