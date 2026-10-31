/**
 * Text scrubbing (port of the text half of `core/mcp/redaction.py`).
 *
 * `scrubText` matches on a normalized copy of the text (`workText.ts`) and removes, in both privacy
 * levels, IBAN-like strings, digit runs with 9+ digits (account, card, phone numbers), masked cards,
 * letter-and-digit ids, numbers after an account word, e-mail addresses and the guard's known person
 * names; in `strict` also every number with 2+ significant digits (money amounts first, as one
 * token). Dates, timestamps, periods and hex digests are protected while the number rules run and
 * restored afterwards.
 *
 * Every pattern is the Python one with Python's Unicode classes (`PY_*` of `@cashu/domain`); the
 * order of the passes is Python's, and so is each replacement.
 */

import { PY_D, PY_END, PY_IC_I, PY_W, PY_WS, uRegex } from "@cashu/domain";
import type { NameGuard } from "./names.js";
import { pyDigitsValue } from "./pyText.js";
import { type Restored, type WorkReplacer, WorkText } from "./workText.js";

// Python `\b` next to a character that is certainly a word character, as one lookaround (the general
// two-sided `PY_B` alternation costs a lookaround pair at every position): before the token's first
// character / after its last one. Same matches as Python's `\b` in these places.
const WB_START = `(?<![${PY_W}])`;
const WB_END = `(?![${PY_W}])`;

// Dates kept while the number rules run (S37fix D3, D5, N2, N6): only valid ones (year 1900-2099,
// month 01-12, day 01-31): ISO dates and timestamps (a fraction of at most 9 digits), periods
// (2024-03, 03/2024, 2024-Q1) and DD.MM.YYYY. Any other date shape is plain digits.
const YEAR = `(?:19|20)${PY_D}{2}`;
const ISO_DATE = uRegex(
  `${WB_START}${YEAR}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]${PY_D}|3[01])` +
    `(?:[T ]${PY_D}{2}:${PY_D}{2}(?::${PY_D}{2}(?:\\.${PY_D}{1,9})?)?(?:Z|[+\\-]${PY_D}{2}:?${PY_D}{2})?)?${WB_END}`,
  "g",
);
const PERIOD = uRegex(
  `${WB_START}${YEAR}-(?:0[1-9]|1[0-2]|Q[1-4])${WB_END}|${WB_START}(?:0[1-9]|1[0-2])/${YEAR}${WB_END}`,
  "g",
);
const DMY_DATE = uRegex(
  `(?<![${PY_W}.,])(?:0?[1-9]|[12]${PY_D}|3[01])\\.(?:0?[1-9]|1[0-2])\\.${YEAR}(?![${PY_W}]|[.,]${PY_D})`,
  "g",
);
// a lower-case hex digest (a content hash prefix: 12+ characters, 3+ letters, no 9 digits in a row)
// is kept like a date: it is neither an account id nor an amount
const HEX_DIGEST = uRegex(
  `(?<![${PY_W}])(?=(?:[0-9a-f]*[a-f]){3})(?![0-9a-f]*${PY_D}{9})[0-9a-f]{12,64}(?![${PY_W}])`,
  "g",
);
// Identifiers, every privacy level (D2, S37fix N4): a run of digit groups joined by any 1-5
// characters that are neither letters nor digits (spaces, punctuation, brackets: "4532, 0151",
// "(22) 123 45 67"), optionally led by a country code, with 9+ digits in all (accounts, IBANs, cards,
// phone numbers); IBANs with letters in the account part; masked cards with their visible digits;
// letter-and-digit ids (8+ characters, 4+ digits); a number after an account word; e-mail addresses.
const SEP = "[^\\p{L}\\p{N}]{1,5}";
/** The narrower separators of IBAN and masked-card shapes (letters take part in those). */
const ID_SEP = "(?: ?[/_\\-]{1,2} ?| {1,3}|[.,])";
const RUN_SOURCE = `(?:(?<![${PY_W}])([A-Z]{2}))?(?<!${PY_D})(${PY_D}+(?:${SEP}${PY_D}+)*)`;
const IBAN_SOURCE = `${WB_START}[A-Z]{2}${PY_D}{2}(?:${ID_SEP}?[A-Z0-9]{4}){3,8}(?:${ID_SEP}?[A-Z0-9]{1,4})?${WB_END}`;
const MASKED_CARD_SOURCE = `(?<![${PY_W}*•])(?:${PY_D}{1,6}${ID_SEP}?)?(?:[*xX•]{2,}${ID_SEP}?){1,4}${PY_D}{2,6}(?!${PY_D})`;
const ALNUM_ID_SOURCE = `(?<![${PY_W}])[${PY_W}]{8,}(?![${PY_W}])`;
const RUN = uRegex(RUN_SOURCE, "g");
const IBAN = uRegex(IBAN_SOURCE, "g");
const MASKED_CARD = uRegex(MASKED_CARD_SOURCE, "g");
const ALNUM_ID = uRegex(ALNUM_ID_SOURCE, "g");
// grouped thousands with a decimal part, one separator throughout, at most 14 digits
const AMOUNT_FORMAT = uRegex(
  `^(?=(?:[^${PY_D}]*${PY_D}){9,14}[^${PY_D}]*$)${PY_D}{1,3}([ .,'])${PY_D}{3}(?:\\1${PY_D}{3})*[.,]${PY_D}{1,2}$`,
);
const LETTER = uRegex(`[\\p{L}\\p{Nl}\\p{No}]`);
const DIGIT = uRegex(PY_D, "g");
const ACCOUNT_ID = uRegex(`${WB_START}[A-Za-z]{1,3}${PY_D}{6,9}${WB_END}`, "g");
const ID_CARD = uRegex(`${WB_START}([A-Z]{3}) ${PY_D}{6}${WB_END}`, "g");
const CURRENCY_CODES: ReadonlySet<string> = new Set(
  "PLN EUR USD GBP CHF JPY CZK HUF SEK NOK DKK CAD AUD".split(" "),
);
// a shorter number right after an account word ("konto nr 12345678")
const ACCOUNT_WORD = uRegex(
  `(?i:${WB_START}(?:konto|konta|rachunek|rachunku|account|acct|acc|nr|numer|no)(?:${WB_END}\\.?|(?=${PY_D}))[ :#]{0,3})` +
    `(?:nr\\.? ?)?(${PY_D}[${PY_D} \\-]{4,}${PY_D})`,
  "g",
);
const EMAIL = uRegex(
  `[${PY_W}.+\\-]+(?:@|\\(at\\)|\\[at\\])[${PY_W}\\-]+(?:\\.[${PY_W}\\-]+)+`,
  "g",
);
// Money (strict): a number next to a currency (any upper-case 3-letter code, Polish / English
// words, symbols), after a money word, with a multiplier (12 tys., 100k), grouped thousands,
// decimals; then every other number with 2+ significant digits (D3).
const CUR =
  `(?:[A-Z]{3}|(?i:zł|zl|złot[${PY_W}]*|zlot[${PY_W}]*|grosz[${PY_W}]*|euro|eur|usd|pln|gbp|chf|dolar[${PY_W}]*` +
  `|funt[${PY_W}]*|frank[${PY_W}]*)|€|\\$|£)`;
const NUM = `[\\-+]?${PY_D}(?:[${PY_D} '.,]*${PY_D})?`;
const MONEY_CUR = uRegex(`(?:${NUM} ?${CUR}(?![A-Za-z]))|(?:(?<![A-Za-z])${CUR} ?${NUM})`, "g");
const MULTIPLIED = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}+(?:[.,]${PY_D}+)?[${PY_WS}]?` +
    `(?i:tys\\.?|tys${PY_IC_I}[eę]c[${PY_W}]*|mln|mld|k|m|mn|bn)(?![${PY_W}])`,
  "g",
);
const NOT_PP = `[${PY_WS}]?pp${WB_END}`;
const GROUPED = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}{1,3}(?:(?:[ ']${PY_D}{3})+|(?:,${PY_D}{3})+|(?:\\.${PY_D}{3}){2,})` +
    `(?:[.,]${PY_D}+)?(?![${PY_W}%]|${NOT_PP}|[${PY_WS}]?%)`,
  "g",
);
const DECIMAL = uRegex(
  `(?<![${PY_W}.,])[\\-+]?${PY_D}+[.,]${PY_D}+(?![${PY_D}%]|[${PY_WS}]?%|${NOT_PP})`,
  "g",
);
const MONEY_WORD = uRegex(
  `(?i:${WB_START}(?:pr${PY_IC_I}ce|pr${PY_IC_I}ces|cena|ceny|cash|amount|kwota|kwoty|value|warto[${PY_W}]*|worth|cost|` +
    `costs|koszt[${PY_W}]*|saldo|balance|depos${PY_IC_I}t[${PY_W}]*|wp[lł]at[${PY_W}]*|wyp[lł]at[${PY_W}]*|fee|fees|tax|` +
    `prow${PY_IC_I}zj[${PY_W}]*|op[lł]at[${PY_W}]*|proceeds|${PY_IC_I}ncome|expense[${PY_W}]*|przych[${PY_W}]*|wydat[${PY_W}]*|` +
    `rata|raty|${PY_IC_I}nstallment)${WB_END}[^${PY_D}\\n]{0,24}?)(?<![${PY_W}.,])([\\-+]?${PY_D}+(?:[ '._•·,]${PY_D}+)*)` +
    `(?![${PY_D}%]|[ '._•·,]${PY_D}|[${PY_WS}]?%|${NOT_PP}|[${PY_WS}]?(?:days?|dni)${WB_END})`,
  "g",
);
// S37fix2 N9: a number glued after letters ("kwota950", "nr1500") is a number too; a sign counts
// only when no letter or digit stands before it ("COVID-19" keeps its dash)
const ANY_NUMBER = uRegex(`(?:(?<![${PY_W}])[\\-+])?(?<!${PY_D})${PY_D}+(?:[.,]${PY_D}+)*`, "g");
// S37fix2 N10: digit groups joined by one grouping character ("2 000", "3 000 %", "2_000 x",
// "5•0000") are one number, masked whole by its significant digits, before a percent sign too
const GROUPED_ANY = uRegex(
  `(?:(?<![${PY_W}])[\\-+])?(?<!${PY_D})${PY_D}+(?:[ '._•·,]${PY_D}+)+`,
  "g",
);
// S37fix2: amounts in words (strict free text). A run of Polish / English number words is masked
// when it holds a word worth 10 or more or a scale word ("dwa tysiące", "pół miliona", "fifty");
// units alone ("dwa", "pięć") stay. Bare English "ten" is left out (Polish "ten" = "this").
const wordList = (source: string) => source.replaceAll("i", PY_IC_I).replaceAll("\\w", `[${PY_W}]`);
const NUMBER_WORDS_BIG = wordList(
  "dziesi[eę][cć]|dziesi[eę]ciu|\\w+na[sś]cie|\\w+nastu|dwadzie[sś]cia|\\w+dziestu|\\w+dzie[sś]ci|" +
    "\\w+dziesi[aą]t|\\w+dziesi[eę]ciu|sto|stu|dwie[sś]cie|dwustu|trzysta|trzystu|czterysta|" +
    "czterystu|(?:pi[eę][cć]|sze[sś][cć]|siedem|osiem|dziewi[eę][cć])set|" +
    "(?:pi[eę]ciu|sze[sś]ciu|siedmiu|o[sś]miu|dziewi[eę]ciu)set|tysi[aą]c\\w*|tysi[eę]c\\w*|tys\\.|" +
    "milion\\w*|miliard\\w*|bilion\\w*|mln\\.?|mld\\.?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|" +
    "seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|" +
    "thousands?|millions?|billions?",
);
const NUMBER_WORDS_SMALL = wordList(
  "zero|jeden|jedna|jedno|jednego|jednej|jednym|dwa|dwie|dw[oó]ch|dwu|dwoma|trzy|trzech|trzema|" +
    "cztery|czterech|pi[eę][cć]|pi[eę]ciu|sze[sś][cć]|sze[sś]ciu|siedem|siedmiu|osiem|o[sś]miu|" +
    "dziewi[eę][cć]|dziewi[eę]ciu|p[oó][lł]|p[oó][lł]tora|one|two|three|four|five|six|seven|eight|" +
    "nine|ten|half",
);
const NUMBER_WORD = `(?:${NUMBER_WORDS_BIG}|${NUMBER_WORDS_SMALL})(?![${PY_W}])`;
const NUMBER_WORDS = uRegex(
  `(?i:(?<![${PY_W}])${NUMBER_WORD}(?:(?: |-| ${PY_IC_I} | and )${NUMBER_WORD})*)`,
  "g",
);
const BIG_NUMBER_WORD = uRegex(`(?i:(?<![${PY_W}])(?:${NUMBER_WORDS_BIG})(?![${PY_W}]))`);
// Kept in strict free text (S37fix R1, R2, N1, N5): a number with at most 3 integer digits and no
// grouping right before a percent sign / percentage points (a decimal part of 1-2 digits allowed) or
// a non-money unit from this closed list (an integer only), or right after a position word ("line
// 12"). A number that touches another digit group through a grouping separator ("1.250 x",
// "450.000 lat") or has a currency next to it, on either side ("zł 500 dni", "999 x PLN"), is never
// kept.
const KEPT_UNITS = (
  "sesja|sesji|sesje|sessions?|dzień|dni|days?|tydzień|tygodni|weeks?|miesiąc|miesięcy|miesiące|" +
  "months?|rok|lat|lata|years?|x|znaków|characters?|linia|lines?|wiersz|rows?|pozycji|positions?"
).replaceAll("i", PY_IC_I);
const NOT_GROUPED = `(?<![${PY_W}.,])(?<!${PY_D}[ '.,_])`;
const KEPT_PERCENT = uRegex(
  `${NOT_GROUPED}[\\-+]?${PY_D}{1,3}(?:[.,]${PY_D}{1,2})?(?![${PY_D}.,'_]${PY_D}|${PY_D})` +
    `(?= ?(?:%|pp${WB_END}|p\\.p\\.|pkt proc\\.))`,
  "g",
);
const KEPT_UNIT = uRegex(
  `${NOT_GROUPED}[\\-+]?${PY_D}{1,3}(?= ?(?i:${KEPT_UNITS})(?![${PY_W}]))`,
  "g",
);
const KEPT_POSITION = uRegex(
  `((?i:${WB_START}(?:${"line|row|linia|linii|wiersz|wiersza|pozycja|pozycji".replaceAll("i", PY_IC_I)})) )` +
    `(${PY_D}{1,3})(?![${PY_D}${PY_W}]|[.,'_ ]${PY_D})`,
  "g",
);
const CURRENCY_WORDS = `zł|zl|złot[${PY_W}]*|zlot[${PY_W}]*|grosz[${PY_W}]*|gr|pln|eur|euro|usd|chf|gbp|dolar[${PY_W}]*|funt[${PY_W}]*|frank[${PY_W}]*`;
const CURRENCY_BEFORE = uRegex(
  `(?:(?i:${WB_START}(?:${CURRENCY_WORDS}))|[$€£]|${WB_START}[A-Z]{3}) {0,3}[\\-+]?${PY_END}`,
);
const CURRENCY_AFTER = uRegex(
  `^ {0,3}(?:(?:%|pp${WB_END}|p\\.p\\.|pkt proc\\.|(?i:${KEPT_UNITS}))(?![${PY_W}]))? {0,3}` +
    `(?:(?i:(?:${CURRENCY_WORDS}))(?![${PY_W}])|[$€£]|[A-Z]{3}(?![A-Za-z]))`,
);
const ISIN_SOURCE = `${WB_START}[A-Z]{2}[A-Z0-9]{9}${PY_D}${WB_END}`;
const ISIN = uRegex(ISIN_SOURCE, "g");
const ISIN_FULL = uRegex(`^[A-Z]{2}[A-Z0-9]{9}${PY_D}$`);
// A protected date / ISIN is swapped for NUL + its index + NUL while the number rules run. The index
// is written in private-use characters, not digits, so no number rule can touch it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the placeholder delimiter
const PLACEHOLDER = /\u0000[-]+\u0000/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the placeholder delimiter this pattern removes
const LEFTOVER = /\u0000[^\u0000]*\u0000|\u0000/gu;
// a whole reference value (`ref` label shape): the leak check does not read it as an account id
const REF_SHAPE = uRegex(`^(?:${PY_D}{1,12}|[a-z][a-z0-9_]*:[0-9a-z]{6,64})${PY_END}`);

function placeholder(index: number): string {
  let digits = "";
  for (const ch of String(index)) digits += String.fromCodePoint(0xe000 + Number(ch));
  return `\u0000${digits}\u0000`;
}

function placeholderIndex(value: string): number {
  let digits = "";
  for (const ch of value.slice(1, -1)) digits += String((ch.codePointAt(0) as number) - 0xe000);
  return Number(digits);
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

type Saved = Restored;

/**
 * Swap dates, timestamps, periods, hex digests (and the given ISINs) for placeholders, restored
 * after scrubbing. ISINs are protected only when a symbol field carried them: in free text an
 * ISIN-shaped token is scrubbed like any other number.
 */
function protectDates(work: WorkText, isins: ReadonlySet<string> = new Set()): Saved[] {
  const saved: Saved[] = [];
  const keep = (m: RegExpMatchArray): string => {
    const start = m.index as number;
    saved.push([m[0], work.src.slice(start, start + m[0].length)]);
    return placeholder(saved.length - 1);
  };
  for (const pattern of [ISO_DATE, PERIOD, DMY_DATE, HEX_DIGEST]) {
    work.sub(pattern, keep, false);
  }
  if (isins.size > 0) work.sub(ISIN, (m) => (isins.has(m[0]) ? keep(m) : null), false);
  return saved;
}

function protectKeptNumbers(work: WorkText, saved: Saved[]): void {
  const nearCurrency = (start: number, end: number): boolean =>
    CURRENCY_BEFORE.test(work.text.slice(0, start)) || CURRENCY_AFTER.test(work.text.slice(end));
  const keep: WorkReplacer = (m) => {
    const start = m.index as number;
    if (nearCurrency(start, start + m[0].length)) return null;
    saved.push([m[0], work.src.slice(start, start + m[0].length)]);
    return placeholder(saved.length - 1);
  };
  work.sub(KEPT_PERCENT, keep, false);
  work.sub(KEPT_UNIT, keep, false);
  work.sub(
    KEPT_POSITION,
    (m) => {
      const start = m.index as number;
      const unit = m[1] as string;
      const number = m[2] as string;
      const at = start + unit.length;
      if (nearCurrency(at, at + number.length)) return null;
      saved.push([number, work.src.slice(at, at + number.length)]);
      const mark = placeholder(saved.length - 1);
      return [unit + mark, [...work.src.slice(start, at), ...Array<null>(mark.length).fill(null)]];
    },
    false,
  );
}

function restoreDates(work: WorkText, saved: readonly Saved[]): void {
  if (work.text.includes("\u0000")) {
    work.sub(
      PLACEHOLDER,
      (m) => {
        const index = placeholderIndex(m[0]);
        return index < saved.length ? (saved[index] as Saved) : "[date]";
      },
      false,
    );
  }
  // never hand placeholder internals to the agent: anything left becomes a clean "[date]"
  if (work.text.includes("\u0000")) work.sub(LEFTOVER, "[date]");
}

function digitCount(text: string): number {
  return Array.from(text.matchAll(DIGIT)).length;
}

const run: WorkReplacer = (m) => {
  const digits = m[2] as string;
  if (digitCount(digits) < 9) return null;
  // "1 234 567,89": an amount (strict masks it as one), not an identifier
  if (m[1] === undefined && AMOUNT_FORMAT.test(digits)) return null;
  return m[1] !== undefined ? "[iban]" : "[number]";
};

const alnumId: WorkReplacer = (m) =>
  digitCount(m[0]) >= 4 && LETTER.test(m[0]) ? "[account]" : null;

const idCard: WorkReplacer = (m) => (CURRENCY_CODES.has(m[1] as string) ? null : "[account]");

const significant: WorkReplacer = (m) => {
  const digits = Array.from(m[0].matchAll(DIGIT), (d) => d[0]);
  let i = 0;
  while (i < digits.length && pyDigitsValue(digits[i] as string) === 0) i++;
  return digits.length - i >= 2 ? "[amount]" : null;
};

/** Replace a match with its text before the last group (the number) and `replacement`. */
/** A link (public source): a number glued to letters in it ("/p11/") is part of a path, not an amount. */
const IN_LINK = uRegex(`(?:https?://|www\\.)[^${PY_WS}]*$`);
const LETTER_CHAR = /^\p{L}$/u;

const anyNumber: WorkReplacer = (m) => {
  const start = m.index as number;
  const before = (m.input as string).slice(0, start);
  const previous = Array.from(before.slice(-2)).pop() ?? "";
  if (LETTER_CHAR.test(previous) && IN_LINK.test(before)) return null;
  return significant(m);
};

const numberWords: WorkReplacer = (m) => (BIG_NUMBER_WORD.test(m[0]) ? "[amount]" : null);

function keepPrefix(replacement: string): WorkReplacer {
  return (m) => m[0].slice(0, m[0].length - (m[1] ?? "").length) + replacement;
}

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
  const work = new WorkText(text);
  const dates = protectDates(work);
  work.sub(MASKED_CARD, "[number]");
  work.sub(IBAN, "[iban]");
  work.sub(RUN, run);
  work.sub(ACCOUNT_ID, "[account]");
  work.sub(ALNUM_ID, alnumId);
  work.sub(ID_CARD, idCard);
  work.sub(ACCOUNT_WORD, keepPrefix("[number]"));
  work.sub(EMAIL, "[email]");
  if (strict) {
    protectKeptNumbers(work, dates);
    work.sub(MONEY_CUR, "[amount]");
    work.sub(MONEY_WORD, keepPrefix("[amount]"));
    work.sub(MULTIPLIED, "[amount]");
    work.sub(NUMBER_WORDS, numberWords);
    work.sub(GROUPED_ANY, significant); // before the decimal rule: "1.2.3" is one number
    work.sub(GROUPED, "[amount]");
    work.sub(DECIMAL, "[amount]");
    work.sub(ANY_NUMBER, anyNumber);
  }
  restoreDates(work, dates);
  text = work.render();
  if (guard !== null) text = guard.mask(text);
  return text;
}

/** True when `text` still holds an identifier-like run (the leak check's string test). */
export function identifierIn(text: string, isins: ReadonlySet<string> = new Set()): boolean {
  const work = new WorkText(text);
  protectDates(work, isins);
  const t = work.text;
  if (searches(IBAN, t) || searches(MASKED_CARD, t)) return true;
  for (const m of t.matchAll(RUN)) if (run(m) !== null) return true;
  if (REF_SHAPE.test(text)) return false;
  for (const m of t.matchAll(ALNUM_ID)) if (alnumId(m) !== null) return true;
  return false;
}

function searches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}
