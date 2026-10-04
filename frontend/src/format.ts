export const pln0 = new Intl.NumberFormat("pl-PL", {
  style: "currency", currency: "PLN", maximumFractionDigits: 0,
});

export const cur = (v: number | null | undefined, c = "PLN"): string =>
  v == null ? "—" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: c }).format(v);

/** Whole units in currency `c` (chart axes): cur0(400000, "EUR") -> "400 000 €". */
export const cur0 = (v: number, c = "PLN"): string =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: c, maximumFractionDigits: 0 }).format(v);

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
