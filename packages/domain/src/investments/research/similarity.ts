/**
 * Near-duplicate research notes (`research/similarity.py`, P9): the same fact written again in other
 * words.
 *
 * A text becomes a token set: casefolded, diacritics stripped (`ł` -> `l` too), split on anything but
 * letters and digits, Polish / English stopwords and one-letter tokens dropped, numbers-only tokens
 * dropped except in titles, each word cut to its first `STEM` characters.
 *
 * Two notes are near duplicates when the Jaccard similarity of their titles, or of their brief
 * headlines (both present), is above `TITLE_MIN`, or that of their bodies (brief headline + the first
 * `BODY_CHARS` characters of the summary) is above `BODY_MIN`, each rule needing `MIN_UNION` distinct
 * tokens. Never a near duplicate: a different polarity or thesis relation; different direction words
 * in the compared texts; titles with different numbers. The headline rule is skipped when both briefs'
 * `why` differ (Jaccard below `TITLE_MIN`).
 *
 * The word lists are matching data: Polish (folded to ASCII) and English, verbatim from Python.
 */

import { pyCasefold } from "../../casefold.js";
import { isCombining, pySplit, pyStrip } from "../../text.js";

export const TITLE_MIN = 0.6;
export const BODY_MIN = 0.7;
export const MIN_UNION = 4;
export const BODY_CHARS = 200;
export const STEM = 4;
/** Notes of the same scope observed this many days back are compared. */
export const WINDOW_DAYS = 60;

/** `_STOPWORDS_TEXT`, verbatim. */
export const STOPWORDS_TEXT = `
    a aby albo ale az bardzo bez beda bedzie bo by byc byl byla byli bylo byly ci co czy dla do
    gdy go i ich im ja jak jako jednak jego jej jest jeszcze juz ku lub ma maja mi mnie na nad nie
    niz o od oraz po pod przed przez przy sa sie sobie ta tak takze tam te tego tej ten to tu tym
    u w we wiec wobec wsrod z za ze zas
    about after an and are as at be been but by for from has have in into is it its of on or
    over than that the their this to under was were will with
`;
/** Polish (without diacritics) and English function words, ignored by `tokens`. */
export const STOPWORDS: ReadonlySet<string> = new Set(pySplit(STOPWORDS_TEXT));

/** Prefixes of folded tokens, then exact English words. */
export type Lexicon = readonly [readonly string[], ReadonlySet<string>];

/** Words of an upward move (`rośnie`, `wzrost`, `podnosi`, `zwiększa`, `up`, `raises`, ...). */
export const UP_WORDS: Lexicon = Object.freeze([
  Object.freeze([
    "rosn",
    "rosl",
    "wzros",
    "wzrost",
    "podnos",
    "podnio",
    "podnie",
    "zwieksz",
    "wchodz",
    "weszl",
    "wejsc",
    "umacn",
    "umocn",
    "drozej",
    "podroz",
    "increas",
  ]),
  new Set(["up", "rise", "rises", "rose", "risen", "raise", "raises", "raised", "higher"]),
] as const);
/** Words of a downward move (`spada`, `obniża`, `zmniejsza`, `słabnie`, `down`, `cuts`, ...). */
export const DOWN_WORDS: Lexicon = Object.freeze([
  Object.freeze([
    "spad",
    "obniz",
    "zmniejsz",
    "wychodz",
    "wyszl",
    "wyjsc",
    "slabn",
    "oslab",
    "tanie",
    "potani",
    "decreas",
  ]),
  new Set([
    "down",
    "cut",
    "cuts",
    "fall",
    "falls",
    "fell",
    "fallen",
    "lower",
    "drop",
    "drops",
    "dropped",
  ]),
] as const);

const TOKEN = /[a-z0-9]+/g;
const ASCII_DIGITS = /^[0-9]+$/;

function ascii(text: string): string {
  const folded = pyCasefold(text).replaceAll("ł", "l").normalize("NFKD");
  let out = "";
  for (const ch of folded) if (!isCombining(ch.codePointAt(0) as number)) out += ch;
  return out;
}

function words(text: string | null | undefined): string[] {
  return ascii(text ?? "").match(TOKEN) ?? [];
}

/** The first `n` code points of `text` (Python `text[:n]`). */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** The normalized token set of `text`; `numbers` keeps numbers-only tokens (titles). */
export function tokens(
  text: string | null | undefined,
  options: { readonly numbers?: boolean } = {},
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const token of words(text)) {
    if (ASCII_DIGITS.test(token)) {
      if (options.numbers) out.add(token);
      continue;
    }
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.add(token.slice(0, STEM));
  }
  return out;
}

function has(list: readonly string[], lexicon: Lexicon): boolean {
  const [prefixes, exact] = lexicon;
  return list.some((w) => exact.has(w) || prefixes.some((p) => w.startsWith(p)));
}

/** `{"up"}`, `{"down"}`, both or none: the direction words in `text`. */
export function directions(text: string | null | undefined): ReadonlySet<string> {
  const list = words(text);
  const found = new Set<string>();
  if (has(list, UP_WORDS)) found.add("up");
  if (has(list, DOWN_WORDS)) found.add("down");
  return found;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * The two texts do not name the same direction: opposite words, or a direction on one side only
 * (a move is a new fact).
 */
export function opposite(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return !sameSet(a, b);
}

export function numbers(text: string | null | undefined): ReadonlySet<string> {
  return new Set(words(text).filter((w) => ASCII_DIGITS.test(w)));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

function unionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return a.size + b.size - common;
}

function similar(a: ReadonlySet<string>, b: ReadonlySet<string>, threshold: number): boolean {
  return unionSize(a, b) >= MIN_UNION && jaccard(a, b) > threshold;
}

/** The text the body comparison reads: the brief headline (when any) and the summary's start. */
export function body(summary: string | null | undefined, headline?: string | null): string {
  return pyStrip(`${headline || ""} ${head(summary || "", BODY_CHARS)}`);
}

export interface Fingerprint {
  readonly title: ReadonlySet<string>;
  readonly body: ReadonlySet<string>;
  /** Tokens of the brief headline (empty without a brief). */
  readonly headline: ReadonlySet<string>;
  /** Tokens of the brief's `why` (empty without a brief). */
  readonly why: ReadonlySet<string>;
  readonly titleDir: ReadonlySet<string>;
  readonly headlineDir: ReadonlySet<string>;
  readonly bodyDir: ReadonlySet<string>;
  readonly titleNumbers: ReadonlySet<string>;
  readonly polarity: string | null;
  readonly relation: string | null;
}

export interface FingerprintOptions {
  readonly why?: string | null;
  readonly polarity?: string | null;
  readonly relation?: string | null;
}

/** `Fingerprint.of(title, summary, headline, why=, polarity=, relation=)`. */
export function fingerprint(
  title: string,
  summary: string,
  headline: string | null = null,
  options: FingerprintOptions = {},
): Fingerprint {
  const text = body(summary, headline);
  return {
    title: tokens(title, { numbers: true }),
    body: tokens(text),
    headline: tokens(headline),
    why: tokens(options.why),
    titleDir: directions(title),
    headlineDir: directions(headline),
    bodyDir: directions(text),
    titleNumbers: numbers(title),
    polarity: options.polarity ?? null,
    relation: options.relation ?? null,
  };
}

export function isNearDuplicate(a: Fingerprint, b: Fingerprint): boolean {
  if (a.polarity !== b.polarity || (a.relation || "none") !== (b.relation || "none")) return false;
  if (a.titleNumbers.size && b.titleNumbers.size && !sameSet(a.titleNumbers, b.titleNumbers)) {
    return false;
  }
  if (!opposite(a.titleDir, b.titleDir) && similar(a.title, b.title, TITLE_MIN)) return true;
  const driversChanged = a.why.size > 0 && b.why.size > 0 && jaccard(a.why, b.why) < TITLE_MIN;
  if (
    !driversChanged &&
    !opposite(a.headlineDir, b.headlineDir) &&
    similar(a.headline, b.headline, TITLE_MIN)
  ) {
    return true;
  }
  return !opposite(a.bodyDir, b.bodyDir) && similar(a.body, b.body, BODY_MIN);
}

/** The first candidate (in the given order) that `next` nearly duplicates, else null. */
export function firstNearDuplicate<T>(
  next: Fingerprint,
  candidates: Iterable<readonly [T, Fingerprint]>,
): T | null {
  for (const [item, print] of candidates) if (isNearDuplicate(next, print)) return item;
  return null;
}
