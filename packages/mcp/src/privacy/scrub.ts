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
/** A Python word list: `i` as Python IGNORECASE reads it, `\w` as Python's word class. */
const wordList = (source: string) => source.replaceAll("i", PY_IC_I).replaceAll("\\w", `[${PY_W}]`);

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
// S37fix3: a run of mask characters is taken whole (atomic, Python's possessive `{2,}+`), never
// split between the groups: a long "xxxx..." word took polynomial time
const MASKED_CARD_SOURCE = `(?<![${PY_W}*•])(?:${PY_D}{1,6}${ID_SEP}?)?(?:(?=([*xX•]{2,}))\\1${ID_SEP}?){1,4}${PY_D}{2,6}(?!${PY_D})`;
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
// S37fix3: an address starts only where a run of address characters starts (no rescan of a long
// word from each of its letters: linear time); addresses chained right after one join it
const EMAIL_ONE = `(?:@|\\(at\\)|\\[at\\])[${PY_W}\\-]+(?:\\.[${PY_W}\\-]+)+`;
const EMAIL = uRegex(
  `(?<![${PY_W}.+\\-])[${PY_W}.+\\-]+${EMAIL_ONE}(?:[.+][${PY_W}.+\\-]*${EMAIL_ONE})*`,
  "g",
);
// Money (strict): a number next to a currency (any upper-case 3-letter code, Polish / English
// words, symbols), after a money word, with a multiplier (12 tys., 100k), grouped thousands,
// decimals; then every other number with 2+ significant digits (D3).
const CUR =
  `(?:[A-Z]{3}|(?i:zł|zl|złot[${PY_W}]*|zlot[${PY_W}]*|grosz[${PY_W}]*|euro|eur|usd|pln|gbp|chf|dolar[${PY_W}]*` +
  `|funt[${PY_W}]*|frank[${PY_W}]*)|€|\\$|£)`;
// S37fix2 W4: the characters that group digits ("2 000", "2'000", "2.000", "5•0000", "1・000",
// "1٬000", "2’000"). Unicode spaces (thin, narrow no-break) are already one ASCII space here (D1).
const GROUP = " '._•·,\u2019\u02bc\u2032\u30fb\u066c\u066b\u2e31\u2027\u2219\u22c5";
const G = `[${GROUP}]`;
const NUM = `[\\-+]?${PY_D}(?:[${PY_D}${GROUP}]*${PY_D})?`;
const MONEY_CUR = uRegex(`(?:${NUM} ?${CUR}(?![A-Za-z]))|(?:(?<![A-Za-z])${CUR} ?${NUM})`, "g");
// S37fix2 W1 / W2: a scale word takes the whole number before it, digit groups included, across any
// run of spaces ("2 tysiące", "3  miliony", "1,5 mln", "2 500 tysięcy", "5k", "2 tyś")
// S37fix3: the other number of a range or an alternative joins it ("2-3 tys.", "2 do 3 tysięcy")
const RANGE_JOIN = `(?:[${PY_WS}]*[\\-/][${PY_WS}]*|[${PY_WS}]+(?i:lub|albo|do|or|to)[${PY_WS}]+)`;
const MULTIPLIED = uRegex(
  `(?<![${PY_W}.,])(?:[\\-+]?${PY_D}+(?:${G}${PY_D}+)*${RANGE_JOIN})?[\\-+]?${PY_D}+(?:${G}${PY_D}+)*[${PY_WS}]*` +
    `(?i:${wordList("ty[sś]\\.?|tysi[aąeę]c\\w*|milion\\w*|miliard\\w*|bilion\\w*|mln|mld|k|m|mn|bn|thousands?|millions?|billions?")})(?![${PY_W}])`,
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
    `rata|raty|${PY_IC_I}nstallment)${WB_END}[^${PY_D}\\n]{0,24}?)(?<![${PY_W}.,])([\\-+]?${PY_D}+(?:${G}${PY_D}+)*)` +
    `(?![${PY_D}%]|${G}${PY_D}|[${PY_WS}]?%|${NOT_PP}|[${PY_WS}]?(?:days?|dni)${WB_END})`,
  "g",
);
// S37fix2 N9: a number glued after letters ("kwota950", "nr1500") is a number too; a sign counts
// only when no letter or digit stands before it ("COVID-19" keeps its dash)
// S37fix3: an exponent is part of the number ("1e4%" is 10 000, not "1" and a kept "4%")
const ANY_NUMBER = uRegex(
  `(?:(?<![${PY_W}])[\\-+])?(?<!${PY_D})${PY_D}+(?:[.,]${PY_D}+)*(?:[eE][\\-+]?${PY_D}+)?`,
  "g",
);
// S37fix2 N10: digit groups joined by one grouping character ("2 000", "3 000 %", "2_000 x",
// "5•0000") are one number, masked whole by its significant digits, before a percent sign too
const GROUPED_ANY = uRegex(`(?:(?<![${PY_W}])[\\-+])?(?<!${PY_D})${PY_D}+(?:${G}${PY_D}+)+`, "g");
// S37fix2: amounts in words (strict free text). A run of Polish / English number words is masked
// when it holds a word worth 10 or more or a scale word ("dwa tysiące", "pół miliona", "fifty");
// units alone ("dwa", "pięć") stay. Bare English "ten" is left out (Polish "ten" = "this").
// S37fix2 W1 / W2: words joined by any run of spaces, a comma, a dash, "i" / "and"; a number in
// digits right before the words joins the run ("2 i pół miliona"); a scale word glued after another
// word (a soft hyphen removed: "dwatysiące") is a scale word; "kilka", "parę", "półtorej", "kilkaset",
// "setki" and the slang "stówa" are number words; "koło", "bańka", "patyk" count as a scale word
// only right after a number or a number word ("dwa koła", "3 patyki"), "bańka spekulacyjna" stays.
const NUMBER_WORDS_BIG = wordList(
  "dziesi[eę][cć]|dziesi[eę]ciu|\\w+na[sś]cie|\\w+nastu|dwadzie[sś]cia|\\w+dziestu|\\w+dzie[sś]ci|" +
    "\\w+dziesi[aą]t|\\w+dziesi[eę]ciu|sto|stu|dwie[sś]cie|dwustu|trzysta|trzystu|czterysta|" +
    "czterystu|(?:pi[eę][cć]|sze[sś][cć]|siedem|osiem|dziewi[eę][cć])set|" +
    "(?:pi[eę]ciu|sze[sś]ciu|siedmiu|o[sś]miu|dziewi[eę]ciu)set|(?:kilka|kilku|par[eę]|paru)set|" +
    "setk\\w*|setek|st[oó]w(?:a|y|ę|ą|ie|ami|ach|om|ka|ki|kę|ką|ek|ce|kami|kach)|stów|tysiak\\w*|" +
    "\\w*tysi[aąeę]c\\w*|ty[sś]\\.?|\\w*milion\\w*|\\w*miliard\\w*|\\w*bilion\\w*|mln\\.?|mld\\.?|eleven|twelve|" +
    "thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|" +
    "seventy|eighty|ninety|hundreds?|\\w*thousands?|\\w*millions?|\\w*billions?",
);
const NUMBER_WORDS_SMALL = wordList(
  "zero|jeden|jedna|jedno|jednego|jednej|jednym|dwa|dwie|dw[oó]ch|dwu|dwoma|trzy|trzech|trzema|" +
    "cztery|czterech|pi[eę][cć]|pi[eę]ciu|sze[sś][cć]|sze[sś]ciu|siedem|siedmiu|osiem|o[sś]miu|" +
    "dziewi[eę][cć]|dziewi[eę]ciu|p[oó][lł]|p[oó][lł]tor(?:a|ej)|kilka|kilku|kilkoma|par[eę]|paru|" +
    "paroma|one|two|three|four|five|six|seven|eight|nine|ten|half",
);
// S37fix3: slang after a number also in English ("2 grand"); a scale abbreviation glued to a number
// word ("dwatys", "pięćmln") is a scale word; a number in digits may be glued to the words ("2koła",
// "2stówy"); words of a range or an alternative join the run ("dwa lub trzy tysiące")
const NUMBER_WORDS_AFTER = wordList("ko[lł][oa]|bańk(?:a|i|ę|ą)|baniek|patyk\\w*|grands?");
const GLUED_SCALE = `(?:${NUMBER_WORDS_SMALL})(?:ty[sś]\\.?|mln\\.?|mld\\.?)`;
const NUMBER_WORD = `(?:${NUMBER_WORDS_BIG}|${GLUED_SCALE}|${NUMBER_WORDS_SMALL})(?![${PY_W}])`;
const WORD_AFTER = `(?:${NUMBER_WORDS_BIG}|${GLUED_SCALE}|${NUMBER_WORDS_SMALL}|${NUMBER_WORDS_AFTER})(?![${PY_W}])`;
const WORD_JOIN = `(?:[${PY_WS}]+(?:${PY_IC_I}|and|lub|albo|do|or|to|x)[${PY_WS}]+|[${PY_WS}]*[,/\\-][${PY_WS}]*|[${PY_WS}]+)`;
const DIGITS_BEFORE = `(?<![${PY_W}.,])[\\-+]?${PY_D}+(?:${G}${PY_D}+)*${WORD_JOIN}?`;
const NUMBER_WORDS = uRegex(
  `(?i:(?:${DIGITS_BEFORE}|(?<![${PY_W}]))${NUMBER_WORD}(?:${WORD_JOIN}${WORD_AFTER})*` +
    `|${DIGITS_BEFORE}(?:${NUMBER_WORDS_AFTER})(?![${PY_W}])(?:${WORD_JOIN}${WORD_AFTER})*)`,
  "g",
);
const BIG_NUMBER_WORD = uRegex(
  `(?i:(?:(?<![${PY_W}])|(?<=${PY_D}))(?:${NUMBER_WORDS_BIG}|${GLUED_SCALE}|${NUMBER_WORDS_AFTER})(?![${PY_W}]))`,
);
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
const NOT_GROUPED = `(?<![${PY_W}.,])(?<!${PY_D}${G})`;
const KEPT_PERCENT = uRegex(
  `${NOT_GROUPED}[\\-+]?${PY_D}{1,3}(?:[.,]${PY_D}{1,2})?(?!${G}${PY_D}|${PY_D})` +
    `(?= ?(?:%|pp${WB_END}|p\\.p\\.|pkt proc\\.))`,
  "g",
);
// S37fix3: "2 x tysiąc" is an amount, not a multiplier
const KEPT_UNIT = uRegex(
  `${NOT_GROUPED}[\\-+]?${PY_D}{1,3}(?= ?(?i:${KEPT_UNITS})(?![${PY_W}]))` +
    `(?! ?(?i:x[${PY_WS}]+(?:${NUMBER_WORDS_BIG}|${GLUED_SCALE}))(?![${PY_W}]))`,
  "g",
);
const KEPT_POSITION = uRegex(
  `((?i:${WB_START}(?:${"line|row|linia|linii|wiersz|wiersza|pozycja|pozycji".replaceAll("i", PY_IC_I)})) )` +
    `(${PY_D}{1,3})(?![${PY_D}${PY_W}]|${G}${PY_D})`,
  "g",
);
const CURRENCY_WORDS = `zł|zl|złot[${PY_W}]*|zlot[${PY_W}]*|grosz[${PY_W}]*|gr|pln|eur|euro|usd|chf|gbp|dolar[${PY_W}]*|funt[${PY_W}]*|frank[${PY_W}]*`;
const CURRENCY_BEFORE = uRegex(
  `(?:(?i:${WB_START}(?:${CURRENCY_WORDS}))|[$€£]|${WB_START}[A-Z]{3}) {0,3}[\\-+]?${PY_END}`,
);
// sticky: matched at the end of the number (no slice of the rest of the text)
const CURRENCY_AFTER = uRegex(
  ` {0,3}(?:(?:%|pp${WB_END}|p\\.p\\.|pkt proc\\.|(?i:${KEPT_UNITS}))(?![${PY_W}]))? {0,3}` +
    `(?:(?i:(?:${CURRENCY_WORDS}))(?![${PY_W}])|[$€£]|[A-Z]{3}(?![A-Za-z]))`,
  "y",
);
const WORD_CHAR = uRegex(`^[${PY_W}]$`);

/**
 * Where the window before a kept number starts (S37fix3 D1): a currency ends at most 4 characters
 * before the number, and the window goes back to the start of the word there, so the rule never
 * reads the whole text before each number (linear for many kept numbers).
 */
function currencyWindow(text: string, start: number): number {
  let window = Math.max(0, start - 5);
  const unit = text.charCodeAt(window);
  if (window > 0 && unit >= 0xdc00 && unit <= 0xdfff) window -= 1; // not inside a surrogate pair
  while (window > 0) {
    const low = text.charCodeAt(window - 1);
    const pair = window > 1 && low >= 0xdc00 && low <= 0xdfff;
    const size = pair ? 2 : 1;
    if (!WORD_CHAR.test(text.slice(window - size, window))) break;
    window -= size;
  }
  return window;
}
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
  const nearCurrency = (start: number, end: number): boolean => {
    const text = work.text;
    if (CURRENCY_BEFORE.test(text.slice(currencyWindow(text, start), start))) return true;
    CURRENCY_AFTER.lastIndex = end;
    return CURRENCY_AFTER.test(text);
  };
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

/**
 * A link (public source): a number glued to letters in it ("/p11/") is part of a path, not an
 * amount. S37fix2 W3: only a link that starts the text or follows a space, "(", "<" or a quote
 * ("xhttps://" is not a link).
 */
const LINK_START = uRegex(`(?:^|(?<=[${PY_WS}(<"'“”„‘’«»]))(?:https?://|www\\.)`, "g");
const SPACE = uRegex(`[${PY_WS}]`, "g");
const LETTER_CHAR = /^\p{L}$/u;
/** S37fix3: a glued number with 4+ digits is masked inside a link too ("https://x.pl/a4532b"). */
const LINK_DIGITS = 4;

/** The first index of the sorted `values` whose value is above `value` (Python `bisect_right`). */
function upperBound(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where the links of a text start, to tell whether a position lies inside one: a link start
 * (`https://`, `http://`, `www.`) ends before the position, with no space after it. Built once per
 * pass (S37fix3), never a rescan of the text before each number, so a long text stays linear.
 */
class LinkIndex {
  private readonly ends: number[] = [];
  /** The latest link start among the first k links by end. */
  private readonly starts: number[] = [];
  private readonly spaces: number[];

  constructor(text: string) {
    const found = Array.from(text.matchAll(LINK_START), (m) => {
      const start = m.index as number;
      return [start + m[0].length, start] as const;
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let latest = -1;
    for (const [end, start] of found) {
      this.ends.push(end);
      latest = Math.max(latest, start);
      this.starts.push(latest);
    }
    this.spaces = Array.from(text.matchAll(SPACE), (m) => m.index as number);
  }

  inside(position: number): boolean {
    const k = upperBound(this.ends, position);
    if (k === 0) return false;
    // the last space before `position` (bisect_left = upperBound of position - 1 on integers)
    const j = upperBound(this.spaces, position - 1);
    return (j > 0 ? (this.spaces[j - 1] as number) : -1) < (this.starts[k - 1] as number);
  }
}

/** The `ANY_NUMBER` replacement for one pass over `text`. */
function anyNumberIn(text: string): WorkReplacer {
  let links: LinkIndex | null = null;
  return (m) => {
    const start = m.index as number;
    const previous = Array.from(text.slice(Math.max(0, start - 2), start)).pop() ?? "";
    if (LETTER_CHAR.test(previous) && digitCount(m[0]) < LINK_DIGITS) {
      links ??= new LinkIndex(text);
      if (links.inside(start)) return null;
    }
    return significant(m);
  };
}

const numberWords: WorkReplacer = (m) => (BIG_NUMBER_WORD.test(m[0]) ? "[amount]" : null);

/** Replace a match with its text before the last group (the number) and `replacement`. */
function keepPrefix(replacement: string): WorkReplacer {
  return (m) => m[0].slice(0, m[0].length - (m[1] ?? "").length) + replacement;
}

/**
 * S37fix3: every scrubbed string is cut to `MAX_SCRUB_CHARS` code points (the longest tool
 * argument, `registry` `MAX_STRING`) before any rule reads it (the raw length is checked before the
 * text is split into code points), and the rules run in linear time, so one long string cannot
 * stall a call. The cut drops the word it splits and any digits or separators before it (no half of
 * a number is left to slip under a threshold), then the whole word before that (the first half of
 * a name split by the cut), and appends `TRUNCATED`.
 */
export const MAX_SCRUB_CHARS = 200_000;
export const TRUNCATED = " [truncated]";
const SPACE_CHAR = uRegex(`^[${PY_WS}]$`);

function cap(text: string): readonly [string, boolean] {
  if (text.length <= MAX_SCRUB_CHARS) return [text, false]; // UTF-16 length >= code points
  let units = 0;
  let count = 0;
  while (units < text.length && count < MAX_SCRUB_CHARS) {
    units += (text.codePointAt(units) as number) > 0xffff ? 2 : 1;
    count += 1;
  }
  if (units >= text.length) return [text, false];
  const chars = Array.from(text.slice(0, units));
  let end = chars.length;
  for (let pass = 0; pass < 2; pass++) {
    // the split word, then the word before it (half of a name, S37fix3)
    while (end > 0 && !SPACE_CHAR.test(chars[end - 1] as string)) end -= 1;
    while (end > 0 && !LETTER_CHAR.test(chars[end - 1] as string)) end -= 1;
  }
  return [chars.slice(0, end).join(""), true];
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
  const [capped, cut] = cap(value);
  let text = capped;
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
    work.sub(ANY_NUMBER, anyNumberIn(work.text));
  }
  restoreDates(work, dates);
  text = work.render();
  if (guard !== null) text = guard.mask(text);
  return cut ? text + TRUNCATED : text;
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
