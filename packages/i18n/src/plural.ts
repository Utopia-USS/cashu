// Plurals through `Intl.PluralRules` (one cached instance per language) where the runtime has it.
// Hermes on iOS ships no `Intl.PluralRules`, so the two languages' integer rules are also written out
// by hand (CLDR: Polish one / few / many, English one / other); tests force that path.
import type { Lang } from "./lang.js";

const rules = new Map<Lang, Intl.PluralRules>();

let intlPlurals: boolean | null = null;
function hasIntlPlurals(): boolean {
  if (intlPlurals === null) intlPlurals = typeof Intl.PluralRules === "function";
  return intlPlurals;
}
/** Test hook: pretend `Intl.PluralRules` is missing (null restores detection). */
export function setPluralRulesForTests(available: boolean | null): void {
  intlPlurals = available;
}

/** CLDR integer categories for pl and en, used where `Intl.PluralRules` is missing. */
function handCategory(l: Lang, n: number): Intl.LDMLPluralRule {
  const i = Math.abs(n);
  if (l === "en") return i === 1 && Number.isInteger(n) ? "one" : "other";
  if (!Number.isInteger(n)) return "other";
  if (i === 1) return "one";
  const i10 = i % 10;
  const i100 = i % 100;
  if (i10 >= 2 && i10 <= 4 && (i100 < 12 || i100 > 14)) return "few";
  return "many";
}

function category(l: Lang, n: number): Intl.LDMLPluralRule {
  if (!hasIntlPlurals()) return handCategory(l, n);
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
