// Plurals through `Intl.PluralRules` (one cached instance per language; works on Hermes too): Polish has
// one / few / many (+ other for fractions), English one / other.
import type { Lang } from "./lang.js";

const rules = new Map<Lang, Intl.PluralRules>();

function category(l: Lang, n: number): Intl.LDMLPluralRule {
  let r = rules.get(l);
  if (!r) {
    r = new Intl.PluralRules(l);
    rules.set(l, r);
  }
  return r.select(n);
}

/** Polish word form: plForm(5, "reguła", "reguły", "reguł") -> "reguł" (2-4 few, but 12-14 many). A fraction
 * keeps the last-digit rule the app has always used (2,5 -> few), where Intl would say "other". */
export function plForm(n: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(n)) {
    const n10 = Math.abs(n) % 10;
    const n100 = Math.abs(n) % 100;
    return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  }
  const c = category("pl", n);
  return c === "one" ? one : c === "few" ? few : many;
}

/** English word form: enForm(1, "rule", "rules") -> "rule". */
export const enForm = (n: number, one: string, other: string): string =>
  category("en", n) === "one" ? one : other;

/** "5 reguł" (number + Polish form). */
export const plCount = (n: number, one: string, few: string, many: string): string =>
  `${n} ${plForm(n, one, few, many)}`;

/** "5 rules" (number + English form). */
export const enCount = (n: number, one: string, other: string): string =>
  `${n} ${enForm(n, one, other)}`;
