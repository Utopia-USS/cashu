// Polish labels and number/date formatting of the investments workspace. Pure (no React, no DOM),
// unit-tested with `npm test`. UI copy rules: Polish, sentence case, regular hyphens only,
// percentages with one decimal and a space before "%", percentage points as "pp".
import { cur, GROUP } from "../../format.ts";

const NBSP = " ";

const num1 = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
const qtyFmt = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 6, ...GROUP });

/** Fraction -> "21,2 %" (one decimal). `signed` adds "+" to positive values. */
export function pct(v: number | null | undefined, signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  const text = num1.format(Math.abs(p) < 0.05 ? 0 : p);
  return `${signed && p > 0.04 ? "+" : ""}${text}${NBSP}%`;
}

/** Fraction -> whole percent when exact ("60 %"), else one decimal ("12,5 %"). Targets and limits. */
export function pctTarget(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  return `${Number.isInteger(p) ? num0.format(p) : num1.format(p)}${NBSP}%`;
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

/** Whole money for hints: "11 600 zł". */
export function money0(v: number | null | undefined, c = "PLN", signed = false): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const text = new Intl.NumberFormat("pl-PL", { style: "currency", currency: c, maximumFractionDigits: 0, ...GROUP }).format(Math.round(v));
  return signed && Math.round(v) > 0 ? `+${text}` : text;
}

/** Quantity without trailing zeros: 120, 0,5, 1,234567. */
export const qty = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "-" : qtyFmt.format(v));

/** Parse a Polish-typed number ("1 234,56", "148.60") -> number | null. */
export function parseNum(text: string): number | null {
  const t = text.replace(/[\s ]/g, "").replace(",", ".");
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Number -> input text in Polish notation (decimal comma, no grouping). */
export const numInput = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v) ? "" : v.toFixed(digits).replace(".", ",");

// ---- dates ---------------------------------------------------------------------
const WEEKDAY_SHORT = ["nd", "pn", "wt", "śr", "czw", "pt", "sob"];
export const WEEKDAYS: Record<string, string> = {
  monday: "poniedziałek", tuesday: "wtorek", wednesday: "środa", thursday: "czwartek",
  friday: "piątek", saturday: "sobota", sunday: "niedziela",
};
export const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** "2026-10-03" or a datetime -> local calendar parts (dates are read as calendar days, not UTC). */
export function dateParts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  if (iso.length > 10 && /T/.test(iso)) {
    const t = new Date(iso);
    if (!Number.isNaN(t.getTime())) return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "3.10" (day.month, no leading zeros) - prose, tags, hints. */
export function dm(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  return p ? `${p.d}.${String(p.m).padStart(2, "0")}` : "-";
}

/** "12.03.2025". */
export function dmy(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  return p ? `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}` : "-";
}

/** "pt 3.10". */
export function wdm(iso: string | null | undefined): string {
  const p = iso ? dateParts(iso) : null;
  if (!p) return "-";
  return `${WEEKDAY_SHORT[new Date(p.y, p.m - 1, p.d).getDay()]} ${dm(iso)}`;
}

/** "17:35" from an ISO datetime (local time). */
export function hm(iso: string | null | undefined): string {
  if (!iso || !/T/.test(iso)) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** Local calendar date "YYYY-MM-DD" of a Date. */
export const isoDate = (t: Date): string =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

// ---- Polish plurals ------------------------------------------------------------
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  const w = n === 1 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${w}`;
}
export const nTxns = (n: number) => plural(n, "transakcja", "transakcje", "transakcji");
export const nTxnsAcc = (n: number) => plural(n, "transakcję", "transakcje", "transakcji");
export const nInstruments = (n: number) => plural(n, "instrument", "instrumenty", "instrumentów");
export const nAccountsInv = (n: number) => plural(n, "rachunek", "rachunki", "rachunków");
export const nChanges = (n: number) => plural(n, "zmiana", "zmiany", "zmian");
export const nSignals = (n: number) => plural(n, "sygnał", "sygnały", "sygnałów");
export const nBuckets = (n: number) => plural(n, "koszyk", "koszyki", "koszyków");
export const nRules = (n: number) => plural(n, "reguła", "reguły", "reguł");

// ---- domain labels -------------------------------------------------------------
export const TXN_TYPE: Record<string, string> = {
  buy: "kupno", sell: "sprzedaż", dividend: "dywidenda", deposit: "wpłata", withdrawal: "wypłata",
  fee: "opłata", tax: "podatek", interest: "odsetki", fx_conversion: "wymiana walut", split: "split",
  transfer_in: "przeniesienie na rachunek", transfer_out: "przeniesienie z rachunku", adjustment: "korekta stanu",
};
export const txnType = (t: string) => TXN_TYPE[t] ?? t;

export const ASSET_CLASS: Record<string, string> = {
  equity: "akcje", etf: "ETF", fund: "fundusz", bond: "obligacje", treasury_bond: "obligacje skarbowe",
  cash: "gotówka", crypto: "kryptowaluty", commodity: "surowce", claim: "wierzytelność", other: "inne",
};
export const assetClass = (v: string | null | undefined) => (v ? ASSET_CLASS[v] ?? v : "-");

export const REGION: Record<string, string> = {
  global: "globalny", developed: "rynki rozwinięte", emerging: "rynki wschodzące", pl: "Polska",
  us: "USA", europe: "Europa", asia: "Azja", unknown: "nieznany",
};
export const region = (v: string | null | undefined) => (v ? REGION[v.toLowerCase()] ?? v : "-");

export const VALUATION: Record<string, string> = { market: "rynek", cost: "koszt", manual: "ręczna" };
export const WRAPPER: Record<string, string> = { regular: "zwykłe", ike: "IKE", ikze: "IKZE", oipe: "OIPE", other: "inne" };

export interface AccountLike { id: number; name: string; broker?: string; broker_name?: string; wrapper?: string }

/** "DIF · zwykłe"; the account name is added when two accounts share broker and wrapper. */
export function accountLabel(a: AccountLike, all: AccountLike[] = []): string {
  const broker = (a.broker_name || a.broker || a.name).replace(/ Broker$/, "");
  const base = `${broker} · ${WRAPPER[a.wrapper ?? ""] ?? a.wrapper ?? ""}`.replace(/ · $/, "");
  const twins = all.filter((x) => x.id !== a.id && x.broker === a.broker && x.wrapper === a.wrapper);
  return twins.length ? `${base} (${a.name})` : base;
}

const BUCKETS: Record<string, string> = {
  global_equity: "Akcje globalne", global_equities: "Akcje globalne", world_equity: "Akcje globalne",
  pl_equity: "Akcje PL", polish_equity: "Akcje PL", pl_equities: "Akcje PL", equity_pl: "Akcje PL",
  us_equity: "Akcje USA", em_equity: "Rynki wschodzące", emerging: "Rynki wschodzące", emerging_markets: "Rynki wschodzące",
  bonds: "Obligacje", bond_etfs: "ETF obligacyjne", treasury_bonds: "Obligacje skarbowe", pl_bonds: "Obligacje",
  cash: "Gotówka", gold: "Złoto", commodities: "Surowce", crypto: "Kryptowaluty", satellite: "Satelity", other: "Inne",
};
/** Strategy bucket id -> Polish label (known ids), else the id made readable. */
export function bucketLabel(id: string | null | undefined): string {
  if (!id) return "Bez koszyka";
  const known = BUCKETS[id.toLowerCase()];
  if (known) return known;
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const BUCKET_COLOR: Record<string, string> = {
  global_equity: "--inv-global", global_equities: "--inv-global", world_equity: "--inv-global",
  pl_equity: "--inv-pl", polish_equity: "--inv-pl", pl_equities: "--inv-pl", equity_pl: "--inv-pl",
  bonds: "--inv-bonds", bond_etfs: "--inv-bonds", treasury_bonds: "--inv-bonds", pl_bonds: "--inv-bonds",
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

export const DECISION_ACTION: Record<string, string> = {
  bought: "dokupuję", sold: "sprzedaję", held: "bez zmian", ignored: "pomijam", other: "odkładam",
};

export const ENTRY_TYPE: Record<string, string> = {
  sentiment_correction: "korekta sentymentu", trend: "trend", special_situation: "sytuacja specjalna",
};

export const RUN_STATUS: Record<string, string> = { ok: "ok", partial: "częściowy", failed: "błąd", running: "w toku" };
