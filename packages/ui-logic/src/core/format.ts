import { intlLocale, lang } from "@cashu/i18n";
import { S, TYPE } from "./format.strings.js";
import { hideAmount } from "./incognito.js";

/** Group thousands from 1 000 on (pl-PL groups only from 10 000 by default: "8600,00 zł" next to
 * "11 240,00 zł" in one column reads badly). */
export const GROUP = { useGrouping: "always" } as unknown as Intl.NumberFormatOptions;

export const cur = (v: number | null | undefined, c = "PLN"): string =>
  v == null
    ? "-"
    : hideAmount(
        new Intl.NumberFormat(intlLocale(), { style: "currency", currency: c, ...GROUP }).format(v),
      );

/** Whole units in currency `c` (chart axes): cur0(400000, "EUR") -> "400 000 €". */
export const cur0 = (v: number, c = "PLN"): string =>
  hideAmount(
    new Intl.NumberFormat(intlLocale(), {
      style: "currency",
      currency: c,
      maximumFractionDigits: 0,
      ...GROUP,
    }).format(v),
  );

export const dtFmt = new Intl.DateTimeFormat(intlLocale(), {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const TYPE_LABEL: Record<string, string> = TYPE;

export const nAccounts = (n: number) => S.nAccounts(n);
export const nModules = (n: number) => S.nModules(n);

const monShort = new Intl.DateTimeFormat(intlLocale(), { month: "short", year: "2-digit" });
/** "2025-03-31" -> "mar 25" (chart x labels). */
export const monthYearShort = (iso: string): string =>
  monShort.format(new Date(`${iso.slice(0, 10)}T12:00:00`));

/** Month names in the genitive ("od września") and nominative ("wrzesień"), January first. */
export const MONTH_GEN: readonly string[] = monthList(() => S.monthGen);
export const MONTH_NOM: readonly string[] = monthList(() => S.monthNom);

/** Twelve indices read from the catalog on each access (the language is read where the name is used). */
function monthList(names: () => readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++)
    Object.defineProperty(out, i, { get: () => names()[i], enumerable: true });
  return out;
}

/** Whole money for facts: "186 401 zł". */
export const cur0s = (v: number | null | undefined, c = "PLN"): string =>
  v == null || !Number.isFinite(v) ? "-" : cur0(round0(v), c);

/** Rounded to whole units without a negative zero: -0.4 -> 0 (never "-0 zł", F7 FE11). */
export const round0 = (v: number): number => Math.round(v) || 0;

/** Fraction -> "+1,2 %" (one decimal, sign for gains; the v2 fact style). */
export function pctSigned(v: number | null | undefined, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const p = Math.round(v * 1000) / 10;
  const t = new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(p) < 0.05 ? 0 : p);
  return `${signed && p > 0.04 ? "+" : ""}${t}${lang() === "pl" ? " %" : "%"}`;
}
