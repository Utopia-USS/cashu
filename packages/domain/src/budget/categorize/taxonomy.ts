/**
 * The category taxonomy and the Polish merchant seed rules (`modules/budget/categorize/taxonomy.py`).
 *
 * Keys and Polish labels are data: the Polish label is the LLM prompt enum (reclassify) and MCP
 * text, so it stays byte-identical to Python. The English label is data for the UI catalogs; which
 * one a screen shows is the i18n layer's choice (D-09.2). Seed needles and text phrases are matched
 * against `merchantKey` / `normalizeText` output (upper case, diacritics stripped).
 */

import { escapeRe } from "../../pyRegex.js";
import { SEED_RULE_DATA } from "./seedRules.js";

export type CategoryKind = "expense" | "income" | "transfer";

export interface Category {
  readonly key: string;
  /** Polish label (`taxonomy.LABELS`): LLM enum data and MCP text. */
  readonly label: string;
  /** English label (`taxonomy.LABELS_EN`). */
  readonly labelEn: string;
  readonly kind: CategoryKind;
}

const category = (key: string, label: string, labelEn: string, kind: CategoryKind): Category => ({
  key,
  label,
  labelEn,
  kind,
});

/** `taxonomy.CATEGORIES` in display order, with `LABELS_EN`. */
export const CATEGORIES: readonly Category[] = Object.freeze([
  category("groceries", "Spożywcze", "Groceries", "expense"),
  category("dining", "Gastronomia", "Dining out", "expense"),
  category("transport", "Transport", "Transport", "expense"),
  category("fuel", "Paliwo", "Fuel", "expense"),
  category("car", "Auto", "Car", "expense"),
  category("housing", "Mieszkanie/Czynsz", "Housing/Rent", "expense"),
  category("loans", "Raty kredytów", "Loan installments", "expense"),
  category("utilities", "Media/Telekom", "Utilities/Telecom", "expense"),
  category("health", "Zdrowie/Apteka", "Health/Pharmacy", "expense"),
  category("shopping", "Zakupy", "Shopping", "expense"),
  category("entertainment", "Rozrywka", "Entertainment", "expense"),
  category("subscriptions", "Subskrypcje", "Subscriptions", "expense"),
  category("travel", "Podróże", "Travel", "expense"),
  category("education", "Edukacja", "Education", "expense"),
  category("personal_care", "Higiena/Uroda", "Personal care/Beauty", "expense"),
  category("gifts", "Prezenty/Darowizny", "Gifts/Donations", "expense"),
  category("private", "Prywatne", "Private", "expense"),
  category("cash", "Gotówka", "Cash", "expense"),
  category("fees", "Opłaty bankowe", "Bank fees", "expense"),
  category("taxes", "Podatki", "Taxes", "expense"),
  category("other", "Inne", "Other", "expense"),
  category("income_salary", "Pensja", "Salary", "income"),
  category("income_refund", "Zwroty", "Refunds", "income"),
  category("income_other", "Inne przychody", "Other income", "income"),
  category("transfer", "Przelew własny", "Own transfer", "transfer"),
  category("cash_withdrawal", "Wypłata gotówki", "Cash withdrawal", "transfer"),
]);

/** `CATEGORY_KEYS`, display order. */
export const CATEGORY_KEYS: readonly string[] = Object.freeze(CATEGORIES.map((c) => c.key));
const KEY_SET: ReadonlySet<string> = new Set(CATEGORY_KEYS);

/** `MANUAL_ONLY`: categories only the owner assigns; never offered to the LLM. */
export const MANUAL_ONLY: ReadonlySet<string> = new Set(["private"]);

/** `AUTO_CATEGORY_KEYS`: every key but `MANUAL_ONLY`, order kept (the LLM enum, byte-identical). */
export const AUTO_CATEGORY_KEYS: readonly string[] = Object.freeze(
  CATEGORY_KEYS.filter((k) => !MANUAL_ONLY.has(k)),
);

/** `engine._INCOME_KEYS`: the income-kind keys. */
export const INCOME_KEYS: ReadonlySet<string> = new Set(
  CATEGORIES.filter((c) => c.kind === "income").map((c) => c.key),
);

/** `reclassify.STRUCTURAL_CATEGORIES`: money moves, never spend or income. */
export const STRUCTURAL_CATEGORIES: ReadonlySet<string> = new Set(["transfer", "cash_withdrawal"]);

/** True for a key of `CATEGORIES` (command validation). */
export function isCategoryKey(key: string): boolean {
  return KEY_SET.has(key);
}

/** The Polish label (`LABELS`) of a key; the key itself when unknown. */
export function categoryLabel(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export interface SeedRule {
  readonly needle: string;
  readonly category: string;
  /** A `word(...)` needle: matches only as a whole word (trailing digits allowed). */
  readonly word: boolean;
}

/** `SEED_RULES` in order (first match wins). */
export const SEED_RULES: readonly SeedRule[] = Object.freeze(
  SEED_RULE_DATA.map(([needle, cat, word]) => ({ needle, category: cat, word })),
);

/** `TEXT_RULES`: phrases matched against the whole normalized transaction text of outflows. */
export const TEXT_RULES: readonly (readonly [string, string])[] = Object.freeze([
  ["CZYNSZ", "housing"],
]);

/**
 * `word.found_in`: Python `(?<![A-Z0-9])<re.escape(needle)>(?![A-Z])` with ASCII classes (no
 * Unicode letter class: a Polish letter before the needle is not a word character here). One regex
 * per word rule, built once.
 */
const MATCHERS: readonly ((mk: string) => boolean)[] = SEED_RULES.map((rule) => {
  if (!rule.word) return (mk: string) => mk.includes(rule.needle);
  const re = new RegExp(`(?<![A-Z0-9])${escapeRe(rule.needle)}(?![A-Z])`, "u");
  return (mk: string) => re.test(mk);
});

/** `apply_seed_rules`: the first seed rule's category found in a merchant key, else null. */
export function applySeedRules(merchantKey: string): string | null {
  if (!merchantKey) return null;
  for (let i = 0; i < MATCHERS.length; i++) {
    if ((MATCHERS[i] as (mk: string) => boolean)(merchantKey)) {
      return (SEED_RULES[i] as SeedRule).category;
    }
  }
  return null;
}

/**
 * `apply_text_rules`: the first phrase found in `text` (normalized), module phrases first, then
 * `TEXT_RULES`. The caller passes `core.textRules(builtinRegistry())`: every registered module,
 * enabled or not (Q19, data a module created keeps being recognised).
 */
export function applyTextRules(
  text: string,
  moduleTextRules: readonly (readonly [string, string])[],
): string | null {
  if (!text) return null;
  for (const [needle, cat] of moduleTextRules) if (text.includes(needle)) return cat;
  for (const [needle, cat] of TEXT_RULES) if (text.includes(needle)) return cat;
  return null;
}
