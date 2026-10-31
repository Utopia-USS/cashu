/**
 * Number formatting of the macro cards (`regimes._number` / `_signed`, `texts.pct` / `pp`) in the UI
 * language: Polish uses a space as the thousands separator and a decimal comma (`1 234,5`), English
 * `1,234.5`. Floats, as in Python (`round` half-even on the binary value, `format(x, ",.Nf")`).
 */

import type { UiLang } from "../../core/i18n.js";
import { formatFloat, roundFloat } from "../../decimal.js";
import { macroStrings } from "./macro.strings.js";

/** `|value|` with `decimals` digits and the language's separators (`regimes._number`). */
export function formatNumber(value: number, decimals: number, lang: UiLang): string {
  const text = formatFloat(Math.abs(value), `,.${decimals}f`);
  if (lang === "en") return text;
  return text.replaceAll(",", " ").replaceAll(".", ",");
}

/** A signed number, never `-0`: `+4,1` / `-6,2` / `0,0` (`regimes._signed`). */
export function formatSigned(value: number, decimals: number, lang: UiLang): string {
  const rounded = roundFloat(value, decimals);
  if (rounded === 0) return formatNumber(0, decimals, lang);
  return (rounded > 0 ? "+" : "-") + formatNumber(rounded, decimals, lang);
}

function pctDecimals(value: number): number {
  return Math.abs(value) * 100 >= 10 ? 0 : 1;
}

/**
 * A fraction as percent: `+4,1 %` / `-12 %` (no decimals from 10 % up); unsigned `4,1 %`. English:
 * `+4.1%` (`texts.pct`).
 */
export function formatPct(value: number, lang: UiLang, signed = true): string {
  const decimals = pctDecimals(value);
  const text = signed
    ? formatSigned(value * 100, decimals, lang)
    : formatNumber(value * 100, decimals, lang);
  return `${text}${macroStrings.percent[lang]}`;
}

/** Python `round(value * 100, pct decimals) == 0`: the fraction shows as zero percent. */
export function pctRoundsToZero(value: number): boolean {
  return roundFloat(value * 100, pctDecimals(value)) === 0;
}

/** Percentage points without a sign: `0,6 pp` / `0.6 pp` (`texts.pp`). */
export function formatPp(value: number, lang: UiLang, decimals = 1): string {
  return `${formatNumber(value, decimals, lang)} pp`;
}
