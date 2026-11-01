/** Deterministic Python rule message formatting; amounts never pass through Number. */
import type { UiLang } from "../../core/i18n.js";
import { D, type Decimal, floatRepr } from "../../decimal.js";
import { supportStrings } from "./support.strings.js";

const NBSP = "\u00a0";
export function decimalText(value: Decimal): string {
  return value.isZero() ? "0" : value.normalize().format("f");
}
function localized(text: string, lang: UiLang): string {
  const sign = text.startsWith("-") ? "-" : "";
  const [whole = "", fraction = ""] = (sign ? text.slice(1) : text).split(".");
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3)
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  return (
    sign +
    groups.join(lang === "pl" ? NBSP : ",") +
    (fraction ? (lang === "pl" ? "," : ".") + fraction : "")
  );
}
function rounded(value: number, digits: number): string {
  const result = D(floatRepr(value)).quantize(-digits, "ROUND_HALF_UP");
  return (result.isZero() ? result.abs() : result).toString();
}
/** ratio is a Python float-derived weight, not a monetary value. */
export function formatPct(ratio: number, lang: UiLang, digits = 1): string {
  return `${localized(rounded(ratio * 100, digits), lang)}${lang === "pl" ? NBSP : ""}%`;
}
export function formatPp(pp: number, lang: UiLang): string {
  return `${localized(rounded(pp, 1), lang)}${NBSP}pp`;
}
export function formatAmount(amount: Decimal, lang: UiLang): string {
  return localized(amount.quantize(0, "ROUND_HALF_UP").toString(), lang);
}
export function formatDecimal(value: Decimal, lang: UiLang): string {
  return localized(decimalText(value), lang);
}
export function daysPhrase(days: number, lang: UiLang): string {
  return supportStrings.days[lang](days);
}
