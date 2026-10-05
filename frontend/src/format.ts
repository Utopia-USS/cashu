/** Group thousands from 1 000 on (pl-PL groups only from 10 000 by default: "8600,00 zł" next to
 * "11 240,00 zł" in one column reads badly). */
export const GROUP = { useGrouping: "always" } as unknown as Intl.NumberFormatOptions;

export const pln0 = new Intl.NumberFormat("pl-PL", {
  style: "currency", currency: "PLN", maximumFractionDigits: 0, ...GROUP,
});

export const cur = (v: number | null | undefined, c = "PLN"): string =>
  v == null ? "-" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: c, ...GROUP }).format(v);

/** Whole units in currency `c` (chart axes): cur0(400000, "EUR") -> "400 000 €". */
export const cur0 = (v: number, c = "PLN"): string =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: c, maximumFractionDigits: 0, ...GROUP }).format(v);

export const dtFmt = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric", month: "short", year: "numeric",
});

/** Read a CSS custom property off :root (theme-aware colors for charts). */
export const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#ca8a04",
  "#db2777", "#4f46e5", "#059669", "#e11d48", "#9333ea", "#f59e0b", "#0ea5e9",
  "#65a30d", "#c026d3", "#14b8a6", "#f43f5e", "#6366f1", "#84cc16", "#a855f7", "#ef4444",
];

export const TYPE_LABEL: Record<string, string> = {
  checking: "Konta osobiste", savings: "Oszczędności", cash: "Gotówka",
  investment: "Inwestycje", property: "Nieruchomości", vehicle: "Auto", credit: "Karty kredytowe",
  mortgage: "Hipoteka", loan: "Pożyczki", other: "Inne",
};

export const pct = (part: number, total: number): number =>
  total ? Math.round((part / total) * 100) : 0;

/** CSS var name for a net-worth component bucket (see analytics.NW_COMPONENT_ORDER). */
export const nwColorVar: Record<string, string> = {
  money: "--nw-money", property: "--nw-property", vehicle: "--nw-vehicle",
  mortgage: "--nw-mortgage", loan: "--nw-loan",
};

/** Polish plural: plural(2, "konto", "konta", "kont") -> "2 konta". */
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  const w = n === 1 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${w}`;
}

export const nAccounts = (n: number) => plural(n, "konto", "konta", "kont");
export const nModules = (n: number) => plural(n, "moduł", "moduły", "modułów");

const WD = ["nd", "pn", "wt", "śr", "czw", "pt", "sob"];
/** "2026-10-02" -> "pt 2.10" (weekday + day.month, the date rule for prose and tags). */
export function wdmShort(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return "-";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${WD[d.getDay()]} ${Number(m[3])}.${m[2]}`;
}

const monShort = new Intl.DateTimeFormat("pl-PL", { month: "short", year: "2-digit" });
/** "2025-03-31" -> "mar 25" (chart x labels). */
export const monthYearShort = (iso: string): string => monShort.format(new Date(`${iso.slice(0, 10)}T12:00:00`));

/** Month names in the genitive ("od września") and nominative ("wrzesień"), January first. */
export const MONTH_GEN = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
export const MONTH_NOM = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];

/** Whole money for facts: "186 401 zł". */
export const cur0s = (v: number | null | undefined, c = "PLN"): string => (v == null || !Number.isFinite(v) ? "-" : cur0(Math.round(v), c));

/** Fraction -> "+1,2 %" (one decimal, sign for gains; the v2 fact style). */
export function pctSigned(v: number | null | undefined, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  const t = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(p) < 0.05 ? 0 : p);
  return `${signed && p > 0.04 ? "+" : ""}${t} %`;
}
