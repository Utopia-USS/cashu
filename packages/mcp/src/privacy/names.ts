/**
 * Person names the MCP layer must never send (port of `core/mcp/names.py`).
 *
 * Sources, per call and per profile: the profile's name, the stored account names, and from the
 * modules' name providers the counterparties of the profile's own transfers (usually the owner's
 * name), bank-transfer payees that look like a private person (no business marker such as
 * "SP Z O O", "SKLEP", "BANK") and owner-named instruments. Card merchants are businesses and are
 * sent as they are.
 *
 * A private-person payee is replaced by an opaque reference `payee:<10 letters>` (an HMAC of the
 * merchant key with a per-installation secret spelled in the letters a-p, so a reference is never a
 * digit run and cannot be reversed by guessing names). Known names inside free text are replaced by
 * `[name]`, matching case- and diacritic-insensitively on word boundaries, also inflected (a Polish
 * ending after the name or its stem), split by any separators, with middle names or initials in
 * between, a hyphenated second surname, and Cyrillic / Greek lookalike letters (S37fix D4).
 */

/// <reference types="node" />
import { createHmac } from "node:crypto";
import {
  escapeRe,
  ignoreCaseLiteral,
  isCombining,
  PY_END,
  PY_W,
  PY_WS,
  pyCasefold,
  pyLen,
  pySplit,
  pyStrip,
  pyUpper,
  uRegex,
} from "@cashu/domain";
import { pyHasDigit, pyIsDigit } from "./pyText.js";

export const REF_PREFIX = "payee:";
const PAYEE_REF = uRegex(`^payee:[a-p]{10}${PY_END}`); // hex digest spelled with letters: never a digit run

/** Words that mark an organisation, not a person (normalized: upper case, no diacritics, no dots). */
export const BUSINESS_MARKERS: ReadonlySet<string> = new Set(
  `
    SP OO ZOO SA SK SKA SPJ SPOLKA SPOLDZIELNIA SPOLDZIELCZY SKLEP SKLEPY SHOP STORE STORES
    MARKET SUPERMARKET HIPERMARKET MARKETS BANK BANKU URZAD SKARBOWY SKARBOWA US ZUS KRUS GMINA
    GMINY MIASTO MIASTA POWIAT WOJEWODZTWO WSPOLNOTA WSPOLNOTY MIESZKANIOWA MIESZKANIOWY
    MIESZKANIOWE FUNDACJA STOWARZYSZENIE PHU PPHU FHU PPH PHP FPHU ZAKLAD ZAKLADY USLUGI
    USLUGOWY USLUGOWE SERWIS SERVICE SERVICES STACJA APTEKA APTEKI RESTAURACJA BAR CAFE
    KAWIARNIA PIEKARNIA HOTEL KLUB CENTRUM SZKOLA PRZEDSZKOLE UCZELNIA UNIWERSYTET KANCELARIA
    BIURO GROUP GRUPA HOLDING LTD LLC INC GMBH AG CO CORP COMPANY POLSKA POLAND ENERGIA ENERGA
    TAURON PGE ENEA ORANGE PLAY PLUS TMOBILE NETIA UPC VECTRA INSURANCE UBEZPIECZENIA
    UBEZPIECZEN TU TUIR PZU LEASING FINANCE FINANSE CREDIT KREDYT KREDYTU POZYCZKA TOWARZYSTWO
    INWESTYCYJNE TFI DOM MAKLERSKI BROKER ADMINISTRACJA ZARZAD NIERUCHOMOSCI OPERATOR GAZOWNIA
    WODOCIAGI WODOCIAGOW CIEPLOWNICTWO PARAFIA KOSCIOL ALLEGRO PAYU PAYPAL REVOLUT WISE STRIPE
    PRZELEWY24 DOTPAY BLIK TPAY POCZTA POLSKA PKP PKO MBANK ING SANTANDER PEKAO ERSTE MILLENNIUM
    ALIOR CITI NEST VELO PROFIT FIRMA HANDEL HANDLOWE HANDLOWA PRODUKCJA TRANSPORT AUTO MOTO
    GARAGE WARSZTAT SALON STUDIO GABINET KLINIKA SZPITAL PRZYCHODNIA MEDICAL MEDICOVER LUXMED
    ENEL FORTUM VEOLIA OPLATA OPLATY RATA PODATEK CZYNSZ
  `
    .trim()
    .split(/\s+/),
);

/**
 * Markers that are also plausible surnames or first names: they only count with another marker or
 * in names of 3+ words ("JAN BAR" is a person, "BAR MLECZNY POD ORLEM" is not).
 */
export const AMBIGUOUS_MARKERS: ReadonlySet<string> = new Set(
  `
    DOM BAR PLUS AUTO MOTO SALON STUDIO PLAY NEST VELO PROFIT CO US TU AG SK SA ING CITI WISE
    SERWIS FIRMA HANDEL BIURO KLUB HOTEL ORANGE
  `
    .trim()
    .split(/\s+/),
);

/** Where an address starts after a name ("ANNA NOWAK UL. POLNA 5 WARSZAWA"). */
const ADDRESS: ReadonlySet<string> = new Set(
  "UL ULICA AL ALEJA ALEJE OS OSIEDLE PL PLAC KOD ADRES".split(" "),
);

const FOLD_EXTRA: Readonly<Record<string, string>> = {
  Ł: "L",
  ł: "L",
  Đ: "D",
  đ: "D",
  Ø: "O",
  ø: "O",
  ß: "SS",
  Æ: "AE",
  æ: "AE",
};

function foldChar(ch: string): string {
  const extra = FOLD_EXTRA[ch];
  if (extra !== undefined) return extra;
  let kept = "";
  for (const c of ch.normalize("NFKD")) {
    if (!isCombining(c.codePointAt(0) as number)) kept += c;
  }
  return pyUpper(kept);
}

/** Upper case without diacritics (`"Łoś"` -> `"LOS"`). */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) out += foldChar(ch);
  return out;
}

/** Cyrillic and Greek letters that look like Latin ones (folded to the Latin letter before matching). */
const CONFUSABLES: ReadonlyMap<string, string> = (() => {
  const from = Array.from("АВЕЅІЈКМНОРСТУХаеіјорсуххѕԁԛԝҮӏΑΒΕΖΗΙΚΜΝΟΡΤΥΧαικνορτυχ");
  const to = Array.from("ABESIJKMHOPCTYXaeijopcyxxsdqwYlABEZHIKMNOPTYXaikvoptux");
  return new Map(from.map((c, i) => [c, to[i] as string]));
})();
const MASK_SPACE: ReadonlySet<string> = new Set(
  Array.from(
    "\t\n\r\u000b\u000c\u001c\u001d\u001e\u001f\u0085\u2028\u2029\u200b\u200c\u200d\u2060\ufeff",
  ),
);
const ZS = /^\p{Zs}$/u;
/** Polish endings after a name or its stem (folded: no diacritics, upper case), longest first. */
const SUFFIXES = [
  "OWEGO",
  "OWEMU",
  "OWYCH",
  "OWEJ",
  "OWNA",
  "OWIE",
  "OWYM",
  "IEGO",
  "IEMU",
  "OWI",
  "OWA",
  "ACH",
  "AMI",
  "IEJ",
  "IMI",
  "YCH",
  "YMI",
  "EGO",
  "EMU",
  "OW",
  "IE",
  "EM",
  "OM",
  "AM",
  "IM",
  "YM",
  "EJ",
  "A",
  "Y",
  "I",
  "E",
  "U",
  "O",
];
const SUFFIX = `(?:${SUFFIXES.join("|")})`;
/**
 * After a shortened stem only inflection endings, not the "-ow-" derivations ("MIESZKANIE" must not
 * reach "MIESZKANIOWA"; "NOWAKOWA" still matches as NOWAK + OWA).
 */
const STEM_SUFFIX = `(?:${SUFFIXES.filter((s) => !s.startsWith("OW")).join("|")})`;
/** Python `[^\W\d_]` (a letter or a non-decimal number) and `[\W_]` as class bodies. */
const LETTER = "\\p{L}\\p{Nl}\\p{No}";
const NOT_ALNUM = "^\\p{L}\\p{N}";
/**
 * Between the words of a name: any separators, up to two middle names or initials (as few as
 * possible, so a middle word never swallows the start of the next occurrence).
 */
const NAME_GAP = `[${NOT_ALNUM}]+(?:[${LETTER}]+\\.?[${NOT_ALNUM}]+){0,2}?`;

/**
 * One character folded for name matching: soft hyphen removed, spaces and zero-width characters to
 * a space, lookalike letters to Latin, then `fold`.
 */
function maskFoldChar(ch: string): string {
  if (ch === "\u00ad") return "";
  if (MASK_SPACE.has(ch) || ZS.test(ch)) return " ";
  return foldChar(CONFUSABLES.get(ch) ?? ch);
}

/**
 * A name word: itself with an optional ending, its stem (1-3 letters shorter, at least `minStem`
 * long) with an ending, or (`initial`) its first letter with a dot (or glued to the next word).
 */
/** Zero-width characters and the soft hyphen, removed in the split fold. */
const MASK_ZERO_WIDTH: ReadonlySet<string> = new Set(
  [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad].map((cp) => String.fromCodePoint(cp)),
);
const LOWER: ReadonlySet<string> = new Set(Array.from("abcdefghijklmnopqrstuvwxyząćęłńóśźż"));
const UPPER: ReadonlySet<string> = new Set(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZĄĆĘŁŃÓŚŹŻ"));
const isLetter = (c: string) => LOWER.has(c) || UPPER.has(c);
const SPLIT_MARK = String.fromCodePoint(1);

/**
 * The folded copies of `text` names are matched on, each with the original code point index of
 * every folded UTF-16 unit: as written; split into words where a name is glued to the next one
 * (zero-width characters removed, a split mark U+0001 inserted at "aN" / "ANo" case changes and
 * after "A."; S37fix N8: "AnnaNowak", "A.Nowak", "ANowak", "An<ZWJ>na"); and as one letter run
 * without marks, for names glued with no case change ("ANNANOWAK", "AnnaNowak123"; S37fix2 N11).
 * The split and run copies read "ß" as the "s" it imitates ("Kowalßki").
 */
function maskFolds(chars: readonly string[]): [string, number[]][] {
  let plain = "";
  const plainIndex: number[] = [];
  chars.forEach((ch, i) => {
    const f = maskFoldChar(ch);
    plain += f;
    for (let k = 0; k < f.length; k++) plainIndex.push(i);
  });
  const kept: [number, string][] = [];
  chars.forEach((ch, i) => {
    if (!MASK_ZERO_WIDTH.has(ch)) kept.push([i, ch]);
  });
  let split = "";
  const splitIndex: number[] = [];
  let run = "";
  const runIndex: number[] = [];
  kept.forEach(([i, ch], k) => {
    const prev = k >= 1 ? (kept[k - 1] as [number, string])[1] : "";
    const prev2 = k >= 2 ? (kept[k - 2] as [number, string])[1] : "";
    const next = k + 1 < kept.length ? (kept[k + 1] as [number, string])[1] : "";
    if (
      (LOWER.has(prev) && UPPER.has(ch)) ||
      (UPPER.has(prev) && UPPER.has(ch) && LOWER.has(next)) ||
      (prev === "." && isLetter(prev2) && isLetter(ch))
    ) {
      split += SPLIT_MARK;
      splitIndex.push(i);
    }
    const f = maskFoldChar(ch === "ß" ? "s" : ch);
    split += f;
    run += f;
    for (let u = 0; u < f.length; u++) {
      splitIndex.push(i);
      runIndex.push(i);
    }
  });
  return [
    [plain, plainIndex],
    [split, splitIndex],
    [run, runIndex],
  ];
}

function wordPattern(word: string, minStem: number, initial: boolean): string {
  let folded = "";
  for (const c of word) folded += maskFoldChar(c);
  const chars = Array.from(folded);
  const alternatives = [`${escapeRe(folded)}${SUFFIX}?`];
  for (const k of [1, 2, 3]) {
    const stem = chars.slice(0, chars.length - k);
    if (chars.length > k && stem.length >= minStem) {
      alternatives.push(escapeRe(stem.join("")) + STEM_SUFFIX);
    }
  }
  // with a dot, or glued to the next word ("ANowak": a split mark follows, see maskFolds)
  if (initial && chars.length > 0) {
    alternatives.push(`${escapeRe(chars[0] as string)}(?:\\.|(?=\\u0001))`);
  }
  return `(?:${alternatives.join("|")})`;
}

function termPattern(words: readonly string[]): string {
  const many = words.length >= 2;
  const parts = words.map((w) => wordPattern(w, many ? 3 : 4, many));
  let orders: string[][] = [Array.from(words)];
  if (words.length >= 2 && words.length <= 3) {
    const unique = new Map<string, string[]>();
    for (const p of permutations(words)) unique.set(p.join("\u0000"), p);
    orders = [...unique.values()].sort(compareTuples);
  }
  const alternatives = orders.map((order) =>
    order.map((w) => parts[words.indexOf(w)] as string).join(NAME_GAP),
  );
  return `(?<![${PY_W}])(?:[${LETTER}]+-)?(?:${alternatives.join("|")})(?:-[${LETTER}]+)?(?![${PY_W}])`;
}

/**
 * A known name glued inside a letter run, with no boundaries (S37fix2 N11): the words in any order
 * with no gap, no initials; a one-word name only from 4 letters on.
 */
function runPattern(words: readonly string[]): string | null {
  const many = words.length >= 2;
  if (!many && pyLen(words[0] as string) < 4) return null;
  const parts = words.map((w) => wordPattern(w, many ? 3 : 4, false));
  let orders: string[][] = [Array.from(words)];
  if (words.length >= 2 && words.length <= 3) {
    const unique = new Map<string, string[]>();
    for (const p of permutations(words)) unique.set(p.join("\u0000"), p);
    orders = [...unique.values()].sort(compareTuples);
  }
  const alternatives = orders.map((order) =>
    order.map((w) => parts[words.indexOf(w)] as string).join(""),
  );
  return `(?:${alternatives.join("|")})`;
}

/**
 * Compiled mask patterns per term, shared by every guard: the MCP server collects a new guard on
 * each call, and compiling a term's patterns (large Unicode classes) costs far more than running
 * them. Python's `re` keeps a compiled-pattern cache the same way. Bounded: cleared when full.
 */
const TERM_PATTERNS = new Map<string, readonly [RegExp, RegExp | null]>();
const TERM_PATTERNS_MAX = 4096;

function termPatterns(term: string, words: readonly string[]): readonly [RegExp, RegExp | null] {
  let entry = TERM_PATTERNS.get(term);
  if (entry === undefined) {
    const glued = runPattern(words);
    entry = [uRegex(termPattern(words), "g"), glued === null ? null : uRegex(glued, "g")];
    if (TERM_PATTERNS.size >= TERM_PATTERNS_MAX) TERM_PATTERNS.clear();
    TERM_PATTERNS.set(term, entry);
  }
  return entry;
}

const DOTS_COMMAS = /[.,]/g;
const SPACES = uRegex(`[${PY_WS}]+`, "g");

/** Folded, dots and commas removed, whitespace collapsed (merchant comparison key). */
export function normalize(text: string | null): string {
  const folded = fold(text ?? "").replace(DOTS_COMMAS, "");
  return pyStrip(folded.replace(SPACES, " "));
}

const TOKEN = uRegex(`^[A-Z][A-Z'\\-]*${PY_END}`);
const NAME_SPLIT = uRegex(`[^${PY_W}'\\-]+`);

function tokens(text: string | null): string[] {
  return pySplit(normalize(text).replaceAll("-", " - ")).filter((t) => t !== "-");
}

/** The leading words before an address or a number ("ANNA NOWAK UL POLNA 5" -> ANNA NOWAK). */
export function personPart(text: string | null): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (ADDRESS.has(t) || pyHasDigit(t)) break;
    out.push(t);
  }
  return out;
}

/**
 * 2-4 words of letters (initials allowed) before any address, none of them a business marker (an
 * ambiguous marker counts only next to another marker or in a longer name).
 */
export function looksLikePerson(text: string | null): boolean {
  const words = personPart(text);
  if (words.length < 2 || words.length > 4) return false;
  if (words.some((t) => !TOKEN.test(t))) return false;
  if (words.filter((t) => pyLen(t) >= 2).length < 1) return false;
  const strong = words.filter((t) => BUSINESS_MARKERS.has(t) && !AMBIGUOUS_MARKERS.has(t));
  const weak = words.filter((t) => AMBIGUOUS_MARKERS.has(t));
  if (strong.length > 0) return false;
  return !(weak.length > 0 && (weak.length >= 2 || words.length >= 3));
}

/** Python `re.split(r"[^\w'-]+", fold(name))` without the empty parts. */
function nameWords(name: string): string[] {
  return fold(name)
    .split(NAME_SPLIT)
    .filter((w) => w !== "");
}

/**
 * Folded terms to mask for a known name: the whole name (2+ words), and with `tokens` each word of
 * 3+ letters (a profile name is a person's or household's name).
 */
export function nameTerms(name: string, { tokens: perWord }: { tokens: boolean }): Set<string> {
  const words = nameWords(name);
  let out = new Set<string>();
  if (words.length >= 2) out.add(words.join(" "));
  if (perWord || words.length === 1) {
    for (const w of words) if (pyLen(w) >= 3 && !pyIsDigit(w)) out.add(w);
  }
  if (!perWord && words.length === 1) out = new Set(); // a one-word account name is not a name
  return out;
}

/** A whole-word match of `term` in a folded text (`containsTerm` in Python). */
function termRe(term: string): RegExp {
  return uRegex(`(?<![${PY_W}])${escapeRe(term)}(?![${PY_W}])`);
}

/** Every ordering of `words` (Python `itertools.permutations`). */
function permutations(words: readonly string[]): string[][] {
  if (words.length <= 1) return [Array.from(words)];
  const out: string[][] = [];
  words.forEach((w, i) => {
    const rest = [...words.slice(0, i), ...words.slice(i + 1)];
    for (const p of permutations(rest)) out.push([w, ...p]);
  });
  return out;
}

/** Python tuple ordering of string tuples (code point order). */
function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return compareStr(x, y);
  }
  return a.length - b.length;
}

function compareStr(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) as number);
  const y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

const HEX_TO_LETTERS = "abcdefghijklmnop";
/** A lone surrogate (Python cannot UTF-8 encode it: the call fails there too). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export type SecretSource = Uint8Array | (() => Uint8Array);

export interface NameGuardInit {
  /** The profile's integer id (part of every payee reference, so references are per profile). */
  readonly profileId: number | bigint;
  /** Folded terms masked in free text. */
  readonly names?: Iterable<string>;
  /** Normalized merchant keys treated as private persons. */
  readonly privatePayees?: Iterable<string>;
  /** The per-installation payee key (or a loader, called once on the first reference). */
  readonly secret?: SecretSource | null;
  /**
   * (owner-typed label, public replacement) pairs swapped in free text in strict mode only: a
   * profile's display-name override of a market instrument becomes its shared market name.
   */
  readonly strictAliases?: Iterable<readonly [string, string]>;
  /** Digit-only tickers of the profile's (not owner-named) instruments (S37fix R5). */
  readonly symbols?: Iterable<string>;
}

export class NameGuard {
  readonly profileId: number | bigint;
  readonly names: ReadonlySet<string>;
  readonly privatePayees: ReadonlySet<string>;
  readonly strictAliases: readonly (readonly [string, string])[];
  /** Digit-only tickers of the profile's instruments: a `symbol` field with one is an instrument. */
  readonly symbols: ReadonlySet<string>;
  private secretSource: SecretSource | null;
  private secret: Uint8Array | null = null;
  // The guard's compiled patterns, built once on first use (the inputs are fixed at construction):
  // Python's `re` caches compiled patterns, so the port compiles each one once per guard instead of
  // once per call (`mask` runs on every string a tool returns).
  private aliasPatterns: readonly (readonly [RegExp, string])[] | null = null;
  private namePatterns: readonly RegExp[] | null = null;
  /** Per term: the bounded pattern (plain and split folds) and the glued one (run fold, or null). */
  private maskPatterns: readonly (readonly [RegExp, RegExp | null])[] | null = null;

  constructor(init: NameGuardInit) {
    this.profileId = init.profileId;
    this.names = new Set(init.names ?? []);
    this.privatePayees = new Set(init.privatePayees ?? []);
    this.secretSource = init.secret ?? null;
    this.strictAliases = Array.from(init.strictAliases ?? [], ([a, p]) => [a, p] as const);
    this.symbols = new Set(init.symbols ?? []);
  }

  /** `text` with every owner-typed alias replaced by its public name (case-insensitive, whole words, longest first). */
  swapAliases(text: string): string {
    if (!text || this.strictAliases.length === 0) return text;
    this.aliasPatterns ??= [...this.strictAliases]
      .sort((a, b) => pyLen(b[0]) - pyLen(a[0]))
      .map(([alias, publicName]) => [
        uRegex(`(?<![${PY_W}])${ignoreCaseLiteral(alias)}(?![${PY_W}])`, "gi"),
        publicName,
      ]);
    let out = text;
    for (const [pattern, publicName] of this.aliasPatterns) {
      out = out.replace(pattern, () => publicName);
    }
    return out;
  }

  /**
   * The shared market name when `label` is (exactly, ignoring case and outer spaces) one of the
   * owner-typed aliases, else `label`.
   */
  publicName(label: string | null): string | null {
    if (!label || this.strictAliases.length === 0) return label;
    const key = pyCasefold(pyStrip(label));
    for (const [alias, publicName] of this.strictAliases) {
      if (pyCasefold(pyStrip(alias)) === key) return publicName;
    }
    return label;
  }

  isPrivate(merchant: string): boolean {
    if (this.privatePayees.has(normalize(merchant))) return true;
    const folded = pyStrip(fold(merchant).split(NAME_SPLIT).join(" "));
    this.namePatterns ??= [...this.names].map(termRe);
    for (const pattern of this.namePatterns) if (pattern.test(folded)) return true;
    // the same words in another order ("NOWAK ANNA" for a known "ANNA NOWAK")
    const words = new Set(pySplit(folded));
    for (const n of this.names) {
      if (!n.includes(" ")) continue;
      const set = new Set(pySplit(n));
      if (set.size >= 2 && [...set].every((w) => words.has(w))) return true;
    }
    return false;
  }

  payeeRef(merchant: string): string {
    if (this.secret === null) {
      const source = this.secretSource;
      if (source === null) throw new Error("no payee key: pass NameGuardInit.secret");
      this.secret = typeof source === "function" ? source() : source;
    }
    const message = `${this.profileId}:${normalize(merchant)}`;
    if (LONE_SURROGATE.test(message))
      throw new TypeError("a merchant name with a lone surrogate cannot be encoded");
    const digest = createHmac("sha256", this.secret)
      .update(message, "utf8")
      .digest("hex")
      .slice(0, 10);
    let letters = "";
    for (const h of digest) letters += HEX_TO_LETTERS[Number.parseInt(h, 16)];
    return REF_PREFIX + letters;
  }

  merchant(value: string | null): string | null {
    if (value === null) return null;
    return this.isPrivate(value) ? this.payeeRef(value) : value;
  }

  /** The candidate merchant key behind `value` (a `payee:` ref or the key itself). */
  resolve(value: string, candidates: Iterable<string>): string | null {
    if (PAYEE_REF.test(value ?? "")) {
      for (const c of candidates) if (this.payeeRef(c) === value) return c;
      return null;
    }
    const key = normalize(value);
    for (const c of candidates) if (normalize(c) === key) return c;
    return null;
  }

  /** Replace known names in `text` by `[name]` (case / diacritic insensitive). */
  mask(text: string): string {
    if (!text || this.names.size === 0) return text;
    const chars = Array.from(text);
    const folds = maskFolds(chars); // folded UTF-16 unit -> code point index in `text`
    const spans: [number, number][] = [];
    this.maskPatterns ??= this.buildMaskPatterns();
    for (const [bounded, glued] of this.maskPatterns) {
      const patterns = [bounded, bounded, glued];
      for (const [f, [folded, index]] of folds.entries()) {
        const pattern = patterns[f];
        if (pattern === null || pattern === undefined) continue;
        pattern.lastIndex = 0;
        for (let m = pattern.exec(folded); m !== null; m = pattern.exec(folded)) {
          const start = index[m.index] as number;
          const end = (index[m.index + m[0].length - 1] as number) + 1;
          if (spans.some(([s, e]) => s < end && start < e)) {
            // overlaps a name already masked: look again one code point on, so a later
            // occurrence is not lost inside the rejected match
            pattern.lastIndex =
              m.index + ((folded.codePointAt(m.index) as number) > 0xffff ? 2 : 1);
            continue;
          }
          spans.push([start, end]);
          pattern.lastIndex = m.index + m[0].length;
        }
      }
    }
    spans.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [start, end] of spans) chars.splice(start, end - start, "[name]");
    return chars.join("");
  }

  /** The `g` patterns per name term: longest first, equal lengths in code point order (as Python sorts them). */
  private buildMaskPatterns(): (readonly [RegExp, RegExp | null])[] {
    const terms = [...this.names].sort((a, b) => pyLen(b) - pyLen(a) || compareStr(a, b));
    const patterns: (readonly [RegExp, RegExp | null])[] = [];
    for (const term of terms) {
      const words = pySplit(term);
      if (words.length === 0) continue; // an empty term (never collected) would match everywhere
      patterns.push(termPatterns(term, words));
    }
    return patterns;
  }
}

export function isPayeeRef(value: string | null): boolean {
  return !!value && PAYEE_REF.test(value);
}

/** What one module contributes to the guard (`name_sources`, `strong_names`, `strict_aliases`). */
export interface NameSources {
  /** Names masked word by word (owner-named instruments). */
  readonly strongNames?: Iterable<string>;
  /** Person names (counterparties of own transfers, owner-given instrument names). */
  readonly persons: Iterable<string>;
  /** Merchant names of private-person payees. */
  readonly privatePayees: Iterable<string>;
  readonly strictAliases?: Iterable<readonly [string, string]>;
  /** Digit-only tickers of the module's (not owner-named) instruments (`known_symbols`). */
  readonly knownSymbols?: Iterable<string>;
}

export interface CollectInput {
  readonly profileId: number | bigint;
  readonly profileName: string | null;
  /** Every stored account name of the profile (removed accounts too). */
  readonly accountNames: Iterable<string | null>;
  /** The modules' name sources in provider order (budget, investments). */
  readonly providers: readonly NameSources[];
  readonly secret?: SecretSource | null;
}

/** `names.collect`: the guard of one profile from its names and the modules' name sources. */
export function collectGuard(input: CollectInput): NameGuard {
  const names = new Set<string>();
  const add = (terms: Set<string>) => {
    for (const t of terms) names.add(t);
  };
  add(nameTerms(input.profileName ?? "", { tokens: true }));
  for (const accountName of input.accountNames)
    add(nameTerms(accountName ?? "", { tokens: false }));
  const payees = new Set<string>();
  const aliases: (readonly [string, string])[] = [];
  const symbols = new Set<string>();
  for (const provider of input.providers) {
    for (const strong of provider.strongNames ?? []) {
      add(nameTerms(strong, { tokens: true }));
      add(nameTerms(personPart(strong).join(" "), { tokens: true }));
    }
    for (const person of provider.persons) {
      add(nameTerms(person, { tokens: false }));
      // also the words before a number / address ("ADAM NOWAK 950" -> "ADAM NOWAK")
      add(nameTerms(personPart(person).join(" "), { tokens: false }));
    }
    const privatePayees = Array.from(provider.privatePayees);
    for (const p of privatePayees) payees.add(normalize(p));
    for (const p of privatePayees) {
      if (looksLikePerson(p)) add(nameTerms(personPart(p).join(" "), { tokens: false }));
    }
    for (const alias of provider.strictAliases ?? []) aliases.push(alias);
    for (const symbol of provider.knownSymbols ?? []) symbols.add(symbol);
  }
  const kept = [...names].filter((n) => !BUSINESS_MARKERS.has(fold(n)));
  return new NameGuard({
    profileId: input.profileId,
    names: kept,
    privatePayees: payees,
    strictAliases: aliases,
    symbols,
    secret: input.secret ?? null,
  });
}
