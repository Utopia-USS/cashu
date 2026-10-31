/**
 * Text scrubbing (port of the text half of `core/mcp/redaction.py`).
 *
 * `scrubText` removes, in both privacy levels, IBAN-like strings, runs of 10+ digits (account, card,
 * phone numbers), dotted account numbers, broker account ids, numbers after an account word, e-mail
 * addresses and the guard's known person names; in `strict` also money amounts (numbers next to a
 * currency, after a money word, with a multiplier, grouped thousands, decimals, integers of 4+ digits
 * that are not a year in context). ISO dates, timestamps and periods are protected while the number
 * rules run and restored afterwards.
 *
 * Every pattern is the Python one with Python's Unicode classes (`PY_*` of `@cashu/domain`); the
 * order of the passes is Python's, and so is each replacement.
 */

import { PY_B, PY_D, PY_END, PY_IC_I, PY_W, PY_WS, pyLen, pyStrip, uRegex } from "@cashu/domain";
import type { NameGuard } from "./names.js";
import { pyDigitsValue } from "./pyText.js";

const ISO_DATE = uRegex(
  `${PY_B}${PY_D}{4}-${PY_D}{2}-${PY_D}{2}(?:[T ]${PY_D}{2}:${PY_D}{2}(?::${PY_D}{2}(?:\\.${PY_D}+)?)?(?:Z|[+\\-]${PY_D}{2}:?${PY_D}{2})?)?${PY_B}`,
  "g",
);
const PERIOD = uRegex(
  `${PY_B}${PY_D}{4}-(?:0[1-9]|1[0-2]|Q[1-4])${PY_B}|${PY_B}(?:0[1-9]|1[0-2])/${PY_D}{4}${PY_B}`,
  "g",
);
// Account numbers: IBANs (groups split by up to two spaces, dots, slashes, underscores or hyphens),
// runs of 10+ digits (same separators except dots, so amounts stay amounts), dotted 4-digit groups,
// broker account ids (U1234567).
const IBAN_SOURCE = `${PY_B}[A-Z]{2}${PY_D}{2}(?:[ \\u00a0._/\\-]{0,2}[A-Z0-9]{4}){3,8}(?:[ \\u00a0._/\\-]{0,2}[A-Z0-9]{1,4})?${PY_B}`;
const LONG_DIGITS_SOURCE = `(?<!${PY_D})${PY_D}(?:[ \\u00a0/_\\-]{0,2}${PY_D}){9,}(?!${PY_D})`;
const DOTTED_ACCOUNT_SOURCE = `(?<![${PY_D}.])${PY_D}{2,4}(?:\\.${PY_D}{4}){3,}(?!${PY_D})`;
const IBAN = uRegex(IBAN_SOURCE, "g");
const LONG_DIGITS = uRegex(LONG_DIGITS_SOURCE, "g");
const DOTTED_ACCOUNT = uRegex(DOTTED_ACCOUNT_SOURCE, "g");
// a shorter number right after an account word ("konto nr 12345678")
const ACCOUNT_WORD = uRegex(
  `(?i:${PY_B}(?:konto|konta|rachunek|rachunku|account|acct|nr|numer|no)${PY_B}\\.?[${PY_WS}:#]{0,3})` +
    `(?:nr\\.?[${PY_WS}]?)?(${PY_D}[${PY_D} \\u00a0\\-]{4,}${PY_D})`,
  "g",
);
const ACCOUNT_ID = uRegex(`${PY_B}[A-Z]{1,3}${PY_D}{6,9}${PY_B}`, "g");
const EMAIL = uRegex(`[${PY_W}.+\\-]+@[${PY_W}\\-]+(?:\\.[${PY_W}\\-]+)+`, "g");
// Money: a number next to a currency (any upper-case 3-letter code, Polish / English words, symbols),
// with a multiplier (12 tys., 100k), grouped thousands, decimals, and integers of 4+ digits that are
// not a year in context.
const CUR =
  `(?:[A-Z]{3}|(?i:zł|zl|złot[${PY_W}]*|zlot[${PY_W}]*|grosz[${PY_W}]*|euro|eur|usd|pln|gbp|chf|dolar[${PY_W}]*` +
  `|funt[${PY_W}]*|frank[${PY_W}]*)|€|\\$|£)`;
const NUM = `[\\-+]?${PY_D}(?:[${PY_D} \\u00a0\\u202f'.,]*${PY_D})?`;
const MONEY_CUR = uRegex(
  `(?:${NUM}[${PY_WS}]?${CUR}(?![A-Za-z]))|(?:(?<![A-Za-z])${CUR}[${PY_WS}]?${NUM})`,
  "g",
);
const MULTIPLIED = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}+(?:[.,]${PY_D}+)?[${PY_WS}]?` +
    `(?i:tys\\.?|tys${PY_IC_I}[eę]c[${PY_W}]*|mln|mld|k|m|mn|bn)(?![${PY_W}])`,
  "g",
);
const NOT_PP = `[${PY_WS}]?pp${PY_B}`;
const GROUPED = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}{1,3}(?:(?:[ \\u00a0\\u202f']${PY_D}{3})+|(?:,${PY_D}{3})+|(?:\\.${PY_D}{3}){2,})` +
    `(?:[.,]${PY_D}+)?(?![${PY_W}%]|${NOT_PP}|[${PY_WS}]?%)`,
  "g",
);
const DECIMAL = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}+[.,]${PY_D}+(?![${PY_D}%]|[${PY_WS}]?%|${NOT_PP})`,
  "g",
);
const BIG_INT = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}{4,}(?![${PY_W}%.,]|[${PY_WS}]?%|${NOT_PP})`,
  "g",
);
const MONEY_WORD = uRegex(
  `(?i:${PY_B}(?:pr${PY_IC_I}ce|pr${PY_IC_I}ces|cena|ceny|cash|amount|kwota|kwoty|value|warto[${PY_W}]*|worth|cost|` +
    `costs|koszt[${PY_W}]*|saldo|balance|depos${PY_IC_I}t[${PY_W}]*|wp[lł]at[${PY_W}]*|wyp[lł]at[${PY_W}]*|fee|fees|tax|` +
    `prow${PY_IC_I}zj[${PY_W}]*|op[lł]at[${PY_W}]*|proceeds|${PY_IC_I}ncome|expense[${PY_W}]*|przych[${PY_W}]*|wydat[${PY_W}]*|` +
    `rata|raty|${PY_IC_I}nstallment)${PY_B}[^${PY_D}\\n]{0,24}?)(?<![${PY_W}.,])([\\-+]?${PY_D}+(?:[.,]${PY_D}+)?)` +
    `(?![${PY_D}%]|[.,]${PY_D}|[${PY_WS}]?%|${NOT_PP}|[${PY_WS}]?(?:days?|dni)${PY_B})`,
  "g",
);
const YEAR_BEFORE = uRegex(
  `(?i:${PY_B}(?:${PY_IC_I}n|w|we|rok|roku|year|years|s${PY_IC_I}nce|od|do|unt${PY_IC_I}l|from|of|z|za|before|after|` +
    `przed|po))[${PY_WS}]+${PY_END}`,
);
const YEAR_AFTER = uRegex(`^[${PY_WS}]?(?:r\\.|rok)`);
const ISIN_SOURCE = `${PY_B}[A-Z]{2}[A-Z0-9]{9}${PY_D}${PY_B}`;
const ISIN = uRegex(ISIN_SOURCE, "g");
const ISIN_FULL = uRegex(`^[A-Z]{2}[A-Z0-9]{9}${PY_D}$`);
// A protected date / ISIN is swapped for NUL + its index + NUL while the number rules run. The index
// is written in private-use characters, not digits, so no number rule can touch it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the placeholder delimiter this pattern removes
const LEFTOVER = /\u0000[^\u0000]*\u0000|\u0000/gu;

function placeholder(index: number): string {
  let digits = "";
  for (const ch of String(index)) digits += String.fromCodePoint(0xe000 + Number(ch));
  return `\u0000${digits}\u0000`;
}

type Replacer = (
  match: string,
  groups: readonly (string | undefined)[],
  offset: number,
  input: string,
) => string;

/** `pattern.sub(fn, text)` with the match, its groups, offset and the whole input. */
function sub(pattern: RegExp, text: string, fn: Replacer): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const offset = args[args.length - 2] as number;
    const input = args[args.length - 1] as string;
    const groups = args.slice(1, -2) as (string | undefined)[];
    return fn(match, groups, offset, input);
  });
}

/** Replace a match with its text before the last group (the number) and `replacement`. */
function keepPrefix(replacement: string): Replacer {
  return (match, groups) => {
    const number = groups[0] ?? "";
    return match.slice(0, match.length - number.length) + replacement;
  };
}

/** ISO 6166 check digit (Luhn over the letters-as-numbers expansion). */
export function isinValid(value: string | null): boolean {
  const v = value ?? "";
  if (!ISIN_FULL.test(v)) return false;
  const chars = Array.from(v);
  const last = chars.pop() as string;
  const digits = chars.map((c) => Number.parseInt(c, 36).toString()).join("");
  let total = 0;
  const reversed = Array.from(digits).reverse();
  reversed.forEach((ch, i) => {
    let n = Number(ch);
    if (i % 2 === 0) {
      n *= 2;
      n = n > 9 ? n - 9 : n;
    }
    total += n;
  });
  return (10 - (total % 10)) % 10 === pyDigitsValue(last);
}

/**
 * Swap ISO dates / timestamps / periods (and the given ISINs) for placeholders, restored after
 * scrubbing. ISINs are protected only when a symbol field carried them: in free text an ISIN-shaped
 * token is scrubbed like any other number.
 */
export function protectDates(
  text: string,
  isins: ReadonlySet<string> = new Set(),
): [string, string[]] {
  const saved: string[] = [];
  const keep: Replacer = (m) => {
    saved.push(m);
    return placeholder(saved.length - 1);
  };
  let out = sub(ISO_DATE, text, keep);
  out = sub(PERIOD, out, keep);
  if (isins.size > 0) out = sub(ISIN, out, (m, g, o, i) => (isins.has(m) ? keep(m, g, o, i) : m));
  return [out, saved];
}

function restoreDates(text: string, saved: readonly string[]): string {
  let out = text;
  saved.forEach((value, i) => {
    out = out.split(placeholder(i)).join(value);
  });
  // never hand placeholder internals to the agent: anything left becomes a clean "[date]"
  return out.includes("\u0000") ? out.replace(LEFTOVER, "[date]") : out;
}

const bigInt: Replacer = (match, _groups, offset, input) => {
  const raw = match.replace(/^[+-]+/, "");
  if (pyLen(raw) === 4) {
    const year = pyDigitsValue(raw);
    if (year >= 1900 && year <= 2100) {
      const before = input.slice(0, offset);
      const after = input.slice(offset + match.length);
      const whole = pyStrip(before) === "" && pyStrip(after) === "";
      if (whole || YEAR_BEFORE.test(before) || YEAR_AFTER.test(after)) return match; // a year in context
    }
  }
  return "[amount]";
};

export interface ScrubOptions {
  readonly strict: boolean;
  readonly guard?: NameGuard | null;
}

export function scrubText(value: string, options: ScrubOptions): string;
export function scrubText(value: string | null, options: ScrubOptions): string | null;
export function scrubText(
  value: string | null,
  { strict, guard = null }: ScrubOptions,
): string | null {
  if (value === null) return null;
  let text = value;
  if (strict && guard !== null) {
    // first, before any rewriting: an alias with a number ("IKE Oli 2030") must still match the
    // owner's label as typed (F7 review R6)
    text = guard.swapAliases(text);
  }
  const [guarded, dates] = protectDates(text);
  text = guarded;
  text = text.replace(IBAN, "[iban]");
  text = text.replace(LONG_DIGITS, "[number]");
  text = text.replace(DOTTED_ACCOUNT, "[number]");
  text = text.replace(ACCOUNT_ID, "[account]");
  text = sub(ACCOUNT_WORD, text, keepPrefix("[number]"));
  text = text.replace(EMAIL, "[email]");
  if (strict) {
    text = text.replace(MONEY_CUR, "[amount]");
    text = sub(MONEY_WORD, text, keepPrefix("[amount]"));
    text = text.replace(MULTIPLIED, "[amount]");
    text = text.replace(GROUPED, "[amount]");
    text = text.replace(DECIMAL, "[amount]");
    text = sub(BIG_INT, text, bigInt);
  }
  text = restoreDates(text, dates);
  if (guard !== null) text = guard.mask(text);
  return text;
}

/** The leak check's identifier patterns, unanchored and without the `g` flag (search only). */
export const LEAK_PATTERNS: readonly RegExp[] = [
  uRegex(IBAN_SOURCE),
  uRegex(LONG_DIGITS_SOURCE),
  uRegex(DOTTED_ACCOUNT_SOURCE),
];
