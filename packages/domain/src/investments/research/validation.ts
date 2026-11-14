/**
 * Pure validation of research input (notes and runs) written by the agent
 * (`research/validation.py`). No I/O; `now` is passed in.
 *
 * A note is facts and sentiment with sources: at least one source with an `http(s)` URL, a publisher
 * and a publication date; bounded lengths; enums from the data contract; no amounts, targets or sizes
 * (`details` takes only the whitelisted keys); never a recommendation or a price prediction (the
 * phrase checks of `patterns.ts`); never a paywall-bypass link. Messages name the field and never
 * echo the value (they reach the agent). Inputs are decoded JSON (`unknown`), checked like Python
 * checks the MCP arguments.
 */

import { pyCasefold } from "../../casefold.js";
import { fromIsoFormat, PyValueError, toOrdinal } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { pyRegex } from "../../pyRegex.js";
import { PY_WS, pyLen, pyStrip, pyUpper } from "../../text.js";
import {
  FULFILLS_THESIS_FIELDS,
  RESEARCH_NOTE_KINDS,
  RESEARCH_NOTE_TTL_DAYS,
  RESEARCH_POLARITIES,
  RESEARCH_SUMMARY_MAX,
  RESEARCH_THESIS_FIELDS,
  RESEARCH_THESIS_RELATIONS,
  RESEARCH_TITLE_MAX,
  THESIS_ENTRY_TYPES,
} from "./contract.js";
import { formatInstant, type Instant, instantDate, isMidnight, MICROS_PER_DAY } from "./instant.js";
import { parseMoment } from "./moment.js";
import {
  claimProblem,
  forecastProblem,
  hasQuantitativeEstimate,
  marketViewProblem,
} from "./patterns.js";
import {
  get,
  isInt,
  isMapping,
  isNone,
  isNumber,
  type JsonObject,
  pyStr,
  truthy,
  unknownKeys,
} from "./pyValue.js";
import { isMacroKey, isNoteSegment, NOTE_SEGMENT_KEYS } from "./segments.js";
import { cleanTheme } from "./themes.js";
import { CONTROL, checkUrl } from "./url.js";

export const TITLE_MIN = 3;
export const SUMMARY_MIN = 10;
export const THEME_MAX = 60;
export const SOURCES_MAX = 10;
export const SOURCE_TITLE_MAX = 200;
export const PUBLISHER_MAX = 80;
export const CRITERIA_MAX = 12;
export const CRITERION_TEXT_MAX = 160;
export const THRESHOLD_TEXT_MAX = 60;
export const CONTEXT_MAX = 200;
export const ASSESSMENT_MIN = 20;
export const ASSESSMENT_MAX = 400;
/** The market view under a topic thesis (P11): bounds per field. */
export const OUTLOOK_MIN = 20;
export const OUTLOOK_MAX = 400;
export const EVENT_MAX = 80;
export const EXPIRES_MAX_DAYS = 90;
export const OBSERVED_MAX_AGE_DAYS = 365;
export const SOURCE_MAX_AGE_DAYS = 3650;
export const FUTURE_TOLERANCE_DAYS = 1;
export const SCOPE_THEMES_MAX = 20;
/** A segment note is short: what happened in the segment, the dated hard data (P5). */
export const SEGMENT_SUMMARY_MAX = 400;
export const SEGMENT_NOTE_KINDS: readonly string[] = Object.freeze(["macro", "trend", "news"]);
export const SEGMENT_ONLY =
  "a segment note is about the market segment only; write instrument facts on the instrument";
export const SCOPE_INSTRUMENTS_MAX = 100;
export const COUNT_MAX = 100_000;
export const REASON_MAX = 200;
/** Counters the agent may report when finishing a run (the server adds notes / signals / kinds). */
export const RUN_COUNT_KEYS: readonly string[] = Object.freeze([
  "sources_checked",
  "instruments_covered",
  "themes_covered",
  "segments_covered",
  "candidates_screened",
  "skipped",
]);
export const COMMUNITY_SCALES: readonly string[] = Object.freeze(["small", "medium", "large"]);
export const DETAILS_KEYS: readonly string[] = Object.freeze([
  "entry_type",
  "criteria",
  "context",
  "bucket",
  "event",
  "event_date",
  "scale",
  "criteria_version",
  "brief",
  "headline",
  "valuation",
]);
export const VALUATION_KEYS: readonly string[] = Object.freeze([
  "pe",
  "forward_pe",
  "eps_growth",
  "pe_avg_5y",
  "basis",
]);
export const VALUATION_BASIS_MAX = 80;
export const BRIEF_HEADLINE_MIN = 8;
export const BRIEF_HEADLINE_MAX = 80;
export const BRIEF_WHY_MIN = 10;
export const BRIEF_WHY_MAX = 280;
export const BRIEF_ITEMS_MAX = 3;
export const BRIEF_ITEM_MAX = 90;
export const BRIEF_KEYS: readonly string[] = Object.freeze([
  "headline",
  "why",
  "supports",
  "risks",
]);
/** The thesis relations a topic note may carry when its topic has a thesis (P9). */
export const TOPIC_THESIS_RELATIONS: readonly string[] = Object.freeze([
  "supports",
  "weakens",
  "invalidates",
]);
export const OUTLOOK_ESTIMATE_MESSAGE =
  "outlook needs a sourced quantitative market or demand estimate (who, how much, horizon)";
/** Sources of a topic market view (P11): 1-6, the industry estimates the outlook cites. */
export const VIEW_SOURCES_MAX = 6;

/** `_CANDIDATE_SYMBOL`, `_EXCHANGE`, `_CURRENCY` Python sources, verbatim. */
export const CANDIDATE_SYMBOL_PATTERN = String.raw`^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$`;
export const EXCHANGE_PATTERN = String.raw`^[A-Za-z0-9 .\-]{1,20}$`;
export const CURRENCY_PATTERN = "^[A-Za-z]{3}$";

const CANDIDATE_SYMBOL = pyRegex(CANDIDATE_SYMBOL_PATTERN);
const EXCHANGE = pyRegex(EXCHANGE_PATTERN);
const CURRENCY = pyRegex(CURRENCY_PATTERN);
const SPACES = new RegExp(`[${PY_WS}]+`, "gu");
const BLANK_LINES = /\n{3,}/g;

/** Invalid research input. `issues`: [field, message]; the message is safe to show. */
export class ResearchInputError extends Error {
  readonly issues: readonly (readonly [string, string])[];

  constructor(message: string, issues?: readonly (readonly [string, string])[]) {
    super(message);
    this.name = "ResearchInputError";
    this.issues = issues && issues.length > 0 ? issues : [["", message]];
  }
}

class Issues {
  readonly items: [string, string][] = [];

  add(where: string, message: string): void {
    this.items.push([where, message]);
  }

  raiseIfAny(): void {
    if (this.items.length === 0) return;
    const text = this.items
      .slice(0, 8)
      .map(([w, m]) => (w ? `${w}: ${m}` : m))
      .join("; ");
    throw new ResearchInputError(text, [...this.items]);
  }
}

// ------------------------------------------------------------------------------- small parsers

interface TextOptions {
  readonly minimum?: number;
  readonly maximum: number;
  readonly required?: boolean;
  readonly multiline?: boolean;
}

function text(issues: Issues, where: string, value: unknown, options: TextOptions): string | null {
  const { minimum = 1, maximum, required = true, multiline = false } = options;
  if (isNone(value) || (typeof value === "string" && !pyStrip(value))) {
    if (required) issues.add(where, "is required");
    return null;
  }
  if (typeof value !== "string") {
    issues.add(where, "must be text");
    return null;
  }
  let out = pyStrip(value);
  if (!multiline) out = out.replace(SPACES, " ");
  else out = out.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(BLANK_LINES, "\n\n");
  if (CONTROL.test(out) || (!multiline && out.includes("\n"))) {
    issues.add(where, `must not contain control characters${multiline ? "" : " or lines"}`);
    return null;
  }
  if (pyLen(out) < minimum) {
    issues.add(where, `is too short (min ${minimum} characters)`);
    return null;
  }
  if (pyLen(out) > maximum) {
    issues.add(where, `is too long (max ${maximum} characters)`);
    return null;
  }
  return out;
}

function oneOf(
  issues: Issues,
  where: string,
  value: unknown,
  allowed: readonly string[],
): string | null {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.add(where, `must be one of: ${allowed.join(", ")}`);
    return null;
  }
  return value;
}

function moment(
  issues: Issues,
  where: string,
  value: unknown,
  now: Instant,
  maxAgeDays: number,
  required = true,
): Instant | null {
  if (isNone(value) || value === "") {
    if (required) issues.add(where, "is required (YYYY-MM-DD or an ISO timestamp)");
    return null;
  }
  const at = parseMoment(value);
  if (at === null) {
    issues.add(where, "must be a date (YYYY-MM-DD) or an ISO timestamp");
    return null;
  }
  if (at > now + BigInt(FUTURE_TOLERANCE_DAYS) * MICROS_PER_DAY) {
    issues.add(where, "must not be in the future");
    return null;
  }
  if (at < now - BigInt(maxAgeDays) * MICROS_PER_DAY) {
    issues.add(where, `is older than ${maxAgeDays} days`);
    return null;
  }
  return at;
}

// ------------------------------------------------------------------------------- notes

export interface SourceInput {
  readonly url: string;
  readonly publisher: string;
  readonly publishedAt: Instant;
  readonly title: string | null;
}

export interface SourceJson {
  readonly title: string | null;
  readonly url: string;
  readonly publisher: string;
  readonly published_at: string;
}

export function sourceJson(source: SourceInput): SourceJson {
  return {
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    published_at: isMidnight(source.publishedAt)
      ? instantDate(source.publishedAt)
      : formatInstant(source.publishedAt),
  };
}

/** A candidate instrument not (yet) in the profile: ticker with market or ISIN, display name. */
export interface CandidateInput {
  readonly symbolOrIsin: string;
  readonly name: string | null;
  readonly exchange: string | null;
  readonly currency: string | null;
}

/** Cooldown key: the upper-case ticker or ISIN as given. */
export function candidateKey(candidate: CandidateInput): string {
  return pyUpper(candidate.symbolOrIsin);
}

export function candidateJson(candidate: CandidateInput): Record<string, string | null> {
  return {
    symbol: candidate.symbolOrIsin,
    name: candidate.name,
    exchange: candidate.exchange,
    currency: candidate.currency,
  };
}

export interface NoteInput {
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly thesisRelation: string;
  readonly title: string;
  readonly summary: string;
  readonly sources: readonly SourceInput[];
  readonly theme: string | null;
  readonly thesisField: string | null;
  readonly observedAt: Instant | null;
  readonly expiresInDays: number;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly candidate: CandidateInput | null;
  /** The market segment of a segment note (catalog key; no instrument, no candidate, P5). */
  readonly segment: string | null;
}

export function noteExpiresAt(note: NoteInput, now: Instant): Instant {
  return (note.observedAt ?? now) + BigInt(note.expiresInDays) * MICROS_PER_DAY;
}

export function noteSourcesJson(note: NoteInput): SourceJson[] {
  return note.sources.map(sourceJson);
}

function sources(issues: Issues, raw: unknown, now: Instant): SourceInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.add("sources", "at least one source is required: [{url, publisher, published_at}]");
    return [];
  }
  if (raw.length > SOURCES_MAX) {
    issues.add("sources", `at most ${SOURCES_MAX} sources`);
    return [];
  }
  const out: SourceInput[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const where = `sources[${i}]`;
    if (!isMapping(item)) {
      issues.add(where, "must be an object {url, publisher, published_at, title?}");
      return;
    }
    if (unknownKeys(item, ["url", "publisher", "published_at", "title"]).length > 0) {
      issues.add(where, "allowed keys: url, publisher, published_at, title");
      return;
    }
    const problem = checkUrl(get(item, "url"));
    if (problem) {
      issues.add(`${where}.url`, problem);
      return;
    }
    const publisher = text(issues, `${where}.publisher`, get(item, "publisher"), {
      maximum: PUBLISHER_MAX,
    });
    const title = text(issues, `${where}.title`, get(item, "title"), {
      maximum: SOURCE_TITLE_MAX,
      required: false,
    });
    const published = moment(
      issues,
      `${where}.published_at`,
      get(item, "published_at"),
      now,
      SOURCE_MAX_AGE_DAYS,
    );
    const url = pyStrip(pyStr(get(item, "url")));
    if (seen.has(url)) {
      issues.add(`${where}.url`, "is listed twice");
      return;
    }
    seen.add(url);
    if (publisher && published !== null)
      out.push({ url, publisher, publishedAt: published, title });
  });
  return out;
}

interface Criterion {
  readonly text: string;
  readonly met: boolean;
  readonly threshold: string | null;
}

function criteria(issues: Issues, raw: unknown): Criterion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.add("details.criteria", "a candidate needs criteria: [{text, met, threshold?}]");
    return null;
  }
  if (raw.length > CRITERIA_MAX) {
    issues.add("details.criteria", `at most ${CRITERIA_MAX} criteria`);
    return null;
  }
  const out: Criterion[] = [];
  raw.forEach((item: unknown, i) => {
    const where = `details.criteria[${i}]`;
    if (!isMapping(item) || unknownKeys(item, ["text", "met", "threshold"]).length > 0) {
      issues.add(where, "must be an object {text, met, threshold?}");
      return;
    }
    const value = text(issues, `${where}.text`, get(item, "text"), {
      maximum: CRITERION_TEXT_MAX,
    });
    const threshold = text(issues, `${where}.threshold`, get(item, "threshold"), {
      maximum: THRESHOLD_TEXT_MAX,
      required: false,
    });
    const met = get(item, "met");
    if (typeof met !== "boolean") {
      issues.add(`${where}.met`, "must be true or false");
      return;
    }
    if (value) out.push({ text: value, met, threshold });
  });
  return out;
}

/**
 * `details.brief` (P9): `{headline, why, supports?, risks?}` in plain Polish for a beginner;
 * `supports` / `risks` (conditions, never predictions) only on a macro note.
 */
function brief(issues: Issues, raw: unknown, macro: boolean): Record<string, unknown> | null {
  const where = "details.brief";
  if (!isMapping(raw)) {
    issues.add(where, "must be an object {headline, why, supports?, risks?}");
    return null;
  }
  if (unknownKeys(raw, BRIEF_KEYS).length > 0) {
    issues.add(where, `allowed keys: ${BRIEF_KEYS.join(", ")}`);
    return null;
  }
  const out: Record<string, unknown> = {};
  const headline = text(issues, `${where}.headline`, get(raw, "headline"), {
    minimum: BRIEF_HEADLINE_MIN,
    maximum: BRIEF_HEADLINE_MAX,
  });
  const why = text(issues, `${where}.why`, get(raw, "why"), {
    minimum: BRIEF_WHY_MIN,
    maximum: BRIEF_WHY_MAX,
  });
  for (const key of ["supports", "risks"]) {
    const items = get(raw, key);
    if (isNone(items) || (Array.isArray(items) && items.length === 0)) {
      out[key] = [];
      continue;
    }
    if (!macro) {
      issues.add(`${where}.${key}`, "only a macro brief lists supports / risks");
      continue;
    }
    if (!Array.isArray(items) || items.length > BRIEF_ITEMS_MAX) {
      issues.add(`${where}.${key}`, `must be a list of at most ${BRIEF_ITEMS_MAX} short texts`);
      continue;
    }
    const parsed: string[] = [];
    items.forEach((item: unknown, i) => {
      const value = text(issues, `${where}.${key}[${i}]`, item, {
        minimum: 3,
        maximum: BRIEF_ITEM_MAX,
      });
      if (value) parsed.push(value);
    });
    out[key] = parsed;
  }
  if (headline === null || why === null) return null;
  return { headline, why, ...out };
}

const PE_MESSAGE = "must be a positive P/E of at most a thousand";
const VALUATION_BOUNDS: readonly (readonly [string, number, number, string])[] = [
  ["pe", 0.1, 1000.0, PE_MESSAGE],
  ["forward_pe", 0.1, 1000.0, PE_MESSAGE],
  ["pe_avg_5y", 0.1, 1000.0, PE_MESSAGE],
  [
    "eps_growth",
    -0.9,
    10.0,
    "must be the yearly growth as a decimal fraction, not percent points " +
      "(thirty-five percent a year is written as a fraction below one)",
  ],
];

/**
 * `details.valuation`: how the market prices a topic or a company, as sourced figures (never a
 * verdict). Messages carry no figures: in strict mode the privacy layer would blank them.
 */
function valuation(issues: Issues, raw: unknown): Record<string, unknown> | null {
  const where = "details.valuation";
  if (!isMapping(raw)) {
    issues.add(where, "must be an object {pe?, forward_pe?, eps_growth?, pe_avg_5y?, basis?}");
    return null;
  }
  if (unknownKeys(raw, VALUATION_KEYS).length > 0) {
    issues.add(where, `allowed keys: ${VALUATION_KEYS.join(", ")}`);
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, low, high, message] of VALUATION_BOUNDS) {
    const value = get(raw, key);
    if (isNone(value)) continue;
    if (!isNumber(value) || !(low <= value && value <= high)) {
      issues.add(`${where}.${key}`, message);
      continue;
    }
    out[key] = roundFloat(value, 4);
  }
  const basis = text(issues, `${where}.basis`, get(raw, "basis"), {
    maximum: VALUATION_BASIS_MAX,
    required: false,
  });
  if (basis) out.basis = basis;
  if (!("pe" in out) && !("forward_pe" in out)) {
    issues.add(where, "needs pe or forward_pe");
    return null;
  }
  return out;
}

function details(
  issues: Issues,
  raw: unknown,
  kind: string,
  now: Instant,
  segment: string | null,
): Record<string, unknown> | null {
  if (isNone(raw)) {
    if (kind === "candidate")
      issues.add("details", "a candidate needs details {entry_type, criteria}");
    return null;
  }
  if (!isMapping(raw)) {
    issues.add("details", "must be an object");
    return null;
  }
  const unknown = unknownKeys(raw, DETAILS_KEYS);
  if (unknown.length > 0) {
    issues.add(
      "details",
      `${unknown.length} unknown key(s); allowed: ${DETAILS_KEYS.join(", ")} ` +
        "(no amounts, targets or position sizes)",
    );
    return null;
  }
  const out: Record<string, unknown> = {};
  if (kind === "candidate") {
    const entry = oneOf(issues, "details.entry_type", get(raw, "entry_type"), THESIS_ENTRY_TYPES);
    const parsed = criteria(issues, get(raw, "criteria"));
    if (entry) out.entry_type = entry;
    if (parsed !== null) out.criteria = parsed;
    const version = get(raw, "criteria_version");
    if (!isNone(version)) {
      if (!isInt(version) || version < 1) {
        issues.add("details.criteria_version", "must be the strategy version (integer)");
      } else {
        out.criteria_version = version;
      }
    }
    const bucket = text(issues, "details.bucket", get(raw, "bucket"), {
      maximum: 40,
      required: false,
    });
    if (bucket) out.bucket = bucket;
  } else {
    for (const key of ["entry_type", "criteria", "criteria_version", "bucket"]) {
      if (!isNone(get(raw, key))) issues.add(`details.${key}`, "only candidate notes carry it");
    }
  }
  const context = text(issues, "details.context", get(raw, "context"), {
    maximum: CONTEXT_MAX,
    required: false,
  });
  if (context) out.context = context;
  if (!isNone(get(raw, "scale"))) {
    if (kind !== "community") {
      issues.add("details.scale", "only community notes carry a scale");
    } else {
      const scale = oneOf(issues, "details.scale", get(raw, "scale"), COMMUNITY_SCALES);
      if (scale) out.scale = scale;
    }
  }
  const event = text(issues, "details.event", get(raw, "event"), {
    maximum: EVENT_MAX,
    required: false,
  });
  const eventRaw = get(raw, "event_date");
  if (!isNone(eventRaw)) {
    let eventDate: string | null = null;
    try {
      eventDate = fromIsoFormat(pyStr(eventRaw));
    } catch (error) {
      if (!(error instanceof PyValueError)) throw error;
      issues.add("details.event_date", "must be a date (YYYY-MM-DD)");
    }
    if (eventDate !== null) {
      if (Math.abs(toOrdinal(eventDate) - toOrdinal(instantDate(now))) > 400) {
        issues.add("details.event_date", "must be within 400 days of today");
      } else if (!event) {
        issues.add("details.event", "name the event the date belongs to");
      } else {
        out.event_date = eventDate;
        out.event = event;
      }
    }
  } else if (event) {
    issues.add("details.event_date", "an event needs its date (YYYY-MM-DD)");
  }
  // The note's headline in plain words (any note): what the app shows first.
  const headline = text(issues, "details.headline", get(raw, "headline"), {
    minimum: BRIEF_HEADLINE_MIN,
    maximum: BRIEF_HEADLINE_MAX,
    required: false,
  });
  if (headline) out.headline = headline;
  if (!isNone(get(raw, "valuation"))) {
    if (segment !== null && isMacroKey(segment)) {
      issues.add(
        "details.valuation",
        "a macro note carries no valuation (a topic or a company does)",
      );
    } else {
      const parsed = valuation(issues, get(raw, "valuation"));
      if (parsed !== null) out.valuation = parsed;
    }
  }
  if (!isNone(get(raw, "brief"))) {
    if (segment === null) {
      issues.add("details.brief", "only a segment or macro note carries a brief");
    } else {
      const parsed = brief(issues, get(raw, "brief"), isMacroKey(segment));
      if (parsed !== null) out.brief = parsed;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function candidate(issues: Issues, raw: unknown): CandidateInput | null {
  if (isNone(raw)) return null;
  if (
    !isMapping(raw) ||
    unknownKeys(raw, ["symbol_or_isin", "name", "exchange", "currency"]).length > 0
  ) {
    issues.add("candidate", "must be an object {symbol_or_isin, name?, exchange?, currency?}");
    return null;
  }
  const symbol = get(raw, "symbol_or_isin");
  if (typeof symbol !== "string" || !CANDIDATE_SYMBOL.test(pyStrip(symbol))) {
    issues.add(
      "candidate.symbol_or_isin",
      "must be a ticker with its market (NVDA.US, PKN.WA, VWCE.DE) or an ISIN",
    );
    return null;
  }
  const name = text(issues, "candidate.name", get(raw, "name"), { maximum: 120, required: false });
  let exchange = get(raw, "exchange");
  if (!isNone(exchange) && (typeof exchange !== "string" || !EXCHANGE.test(exchange))) {
    issues.add("candidate.exchange", "must be an exchange code (GPW, XETRA, NASDAQ, US)");
    exchange = null;
  }
  let currency = get(raw, "currency");
  if (!isNone(currency) && (typeof currency !== "string" || !CURRENCY.test(currency))) {
    issues.add("candidate.currency", "must be a 3-letter currency code");
    currency = null;
  }
  return {
    symbolOrIsin: pyStrip(symbol),
    name,
    exchange: typeof exchange === "string" ? pyStrip(exchange) : null,
    currency: typeof currency === "string" ? pyUpper(currency) : null,
  };
}

/**
 * The texts of a valid note that read like a forecast, a call, a rating or a price target (P9): a
 * warning, never a refusal. A note is a sourced fact; an opinion that follows from the owner's
 * strategy belongs in the model's recommendation, and the agent decides whether to rewrite. Returns
 * the field paths (`title`, `details.headline`, `details.brief.why`, ...).
 */
export function noteWordingWarnings(note: NoteInput): string[] {
  const texts: [string, unknown][] = [
    ["title", note.title],
    ["summary", note.summary],
    ["details.headline", note.details?.headline],
  ];
  const brief = note.details?.brief;
  if (isMapping(brief)) {
    texts.push(
      ["details.brief.headline", get(brief, "headline")],
      ["details.brief.why", get(brief, "why")],
    );
    for (const key of ["supports", "risks"]) {
      const items = get(brief, key);
      if (!Array.isArray(items)) continue;
      items.forEach((item: unknown, i) => {
        texts.push([`details.brief.${key}[${i}]`, item]);
      });
    }
  }
  const out: string[] = [];
  for (const [where, value] of texts) {
    if (typeof value !== "string") continue;
    // A headline or brief also avoids plain forecast words; title and summary only advice and price calls.
    const short = where !== "title" && where !== "summary";
    if (claimProblem(value) || (short && forecastProblem(value))) out.push(where);
  }
  return out;
}

/**
 * Check one note (the MCP arguments, without instrument / run resolution, which need the store).
 * Throws `ResearchInputError` listing every problem.
 */
export function validateNote(raw: JsonObject, now: Instant): NoteInput {
  const issues = new Issues();
  const kind = oneOf(issues, "kind", get(raw, "kind"), RESEARCH_NOTE_KINDS);
  const polarity = oneOf(issues, "polarity", get(raw, "polarity"), RESEARCH_POLARITIES);
  let strength: number | null = null;
  const strengthRaw = get(raw, "strength");
  if (!isInt(strengthRaw) || strengthRaw < 1 || strengthRaw > 3) {
    issues.add("strength", "must be 1, 2 or 3");
  } else {
    strength = strengthRaw;
  }
  const relationRaw = get(raw, "thesis_relation");
  const relation = oneOf(
    issues,
    "thesis_relation",
    truthy(relationRaw) ? relationRaw : "none",
    RESEARCH_THESIS_RELATIONS,
  );
  let thesisField: string | null = null;
  const thesisFieldRaw = get(raw, "thesis_field");
  if (!isNone(thesisFieldRaw)) {
    thesisField = oneOf(issues, "thesis_field", thesisFieldRaw, RESEARCH_THESIS_FIELDS);
    if (thesisField && (relation === null || relation === "none")) {
      issues.add("thesis_field", "only with a thesis_relation other than none");
    } else if (
      thesisField &&
      relation === "fulfills" &&
      !FULFILLS_THESIS_FIELDS.includes(thesisField)
    ) {
      issues.add(
        "thesis_field",
        "a fulfills note names the thesis or its exit_plan (the outcome that happened)",
      );
    }
  }
  const title = text(issues, "title", get(raw, "title"), {
    minimum: TITLE_MIN,
    maximum: RESEARCH_TITLE_MAX,
  });
  const summary = text(issues, "summary", get(raw, "summary"), {
    minimum: SUMMARY_MIN,
    maximum: RESEARCH_SUMMARY_MAX,
    multiline: true,
  });
  const themeRaw = get(raw, "theme");
  let theme: string | null = null;
  if (!isNone(themeRaw)) {
    theme = text(issues, "theme", cleanTheme(pyStr(themeRaw)), { minimum: 2, maximum: THEME_MAX });
  }
  let segment: string | null = null;
  const segmentRaw = get(raw, "segment");
  if (!isNone(segmentRaw)) {
    if (!isNoteSegment(segmentRaw)) {
      issues.add("segment", `must be one of: ${NOTE_SEGMENT_KEYS.join(", ")}`);
    } else {
      segment = segmentRaw;
      if (!isNone(get(raw, "candidate"))) issues.add("segment", SEGMENT_ONLY);
      if (!isNone(themeRaw)) {
        issues.add("theme", "a segment note has no theme (themes are gone: use segment)");
      }
      if (kind !== null && !SEGMENT_NOTE_KINDS.includes(kind)) {
        issues.add("kind", `a segment note is one of: ${SEGMENT_NOTE_KINDS.join(", ")}`);
      }
      if (relation !== null && relation !== "none") {
        if (isMacroKey(segment)) {
          issues.add("thesis_relation", "a macro note has no thesis: use none");
        } else if (!TOPIC_THESIS_RELATIONS.includes(relation)) {
          issues.add(
            "thesis_relation",
            `a topic note bears on its topic thesis with one of: ${TOPIC_THESIS_RELATIONS.join(", ")} (or none)`,
          );
        } else if (thesisField !== null && thesisField !== "thesis") {
          issues.add("thesis_field", "a topic note bears on the topic thesis: use thesis");
        } else {
          thesisField = "thesis";
        }
      }
      if (summary !== null && pyLen(summary) > SEGMENT_SUMMARY_MAX) {
        issues.add(
          "summary",
          `is too long for a segment note (max ${SEGMENT_SUMMARY_MAX} characters)`,
        );
      }
    }
  }
  const parsedSources = sources(issues, get(raw, "sources"), now);
  const observed = moment(
    issues,
    "observed_at",
    get(raw, "observed_at"),
    now,
    OBSERVED_MAX_AGE_DAYS,
    false,
  );
  const expiresRaw = get(raw, "expires_in_days");
  let expiresIn = RESEARCH_NOTE_TTL_DAYS;
  if (isNone(expiresRaw)) {
    expiresIn = RESEARCH_NOTE_TTL_DAYS;
  } else if (!isInt(expiresRaw)) {
    issues.add("expires_in_days", "must be an integer");
  } else if (expiresRaw < 1 || expiresRaw > EXPIRES_MAX_DAYS) {
    issues.add("expires_in_days", `must be between 1 and ${EXPIRES_MAX_DAYS}`);
  } else {
    expiresIn = expiresRaw;
  }
  const parsedDetails = kind ? details(issues, get(raw, "details"), kind, now, segment) : null;
  const parsedCandidate = candidate(issues, get(raw, "candidate"));
  if (kind === "candidate") {
    if (relation !== null && relation !== "none") {
      issues.add("thesis_relation", "a candidate has no thesis yet: use none");
    }
  } else if (parsedCandidate !== null) {
    issues.add("candidate", "only candidate notes name a candidate instrument");
  }
  if (observed !== null && observed + BigInt(expiresIn) * MICROS_PER_DAY <= now) {
    issues.add("observed_at", "the note would already be expired (raise expires_in_days)");
  }
  issues.raiseIfAny();
  if (!kind || !polarity || strength === null || !relation || !title || !summary) {
    throw new Error("validateNote: a required field is missing without an issue");
  }
  return {
    kind,
    polarity,
    strength,
    thesisRelation: relation,
    title,
    summary,
    sources: parsedSources,
    theme,
    thesisField,
    observedAt: observed,
    expiresInDays: expiresIn,
    details: parsedDetails,
    candidate: parsedCandidate,
    segment,
  };
}

// ------------------------------------------------------------------------------- market view

/** Validate the current market assessment under a topic thesis (P11). */
export function validateAssessment(value: unknown): string {
  const issues = new Issues();
  const assessment = text(issues, "assessment", value, {
    minimum: ASSESSMENT_MIN,
    maximum: ASSESSMENT_MAX,
    multiline: true,
  });
  issues.raiseIfAny();
  return assessment as string;
}

/**
 * Validate a forward market scenario: direction and horizon, never a security price call.
 * `quantitative` (the agent's view): it must also name a number, the cited industry estimate.
 */
export function validateOutlook(value: unknown, quantitative = false): string {
  const issues = new Issues();
  const outlook = text(issues, "outlook", value, {
    minimum: OUTLOOK_MIN,
    maximum: OUTLOOK_MAX,
    multiline: true,
  });
  if (quantitative && outlook && !hasQuantitativeEstimate(outlook)) {
    issues.add("", OUTLOOK_ESTIMATE_MESSAGE);
  }
  issues.raiseIfAny();
  return outlook as string;
}

/**
 * The parts of a topic market view that read like a buy / sell call or a security price prediction
 * (P11): a warning, never a refusal (`assessment`, `outlook`).
 */
export function marketViewWarnings(view: {
  readonly assessment?: string | null;
  readonly outlook?: string | null;
}): string[] {
  return (["assessment", "outlook"] as const).filter((key) => marketViewProblem(view[key]));
}

/** Validate the sources of a topic market view: 1-`VIEW_SOURCES_MAX` items, like note sources. */
export function validateViewSources(raw: unknown, now: Instant): SourceJson[] {
  const issues = new Issues();
  if (Array.isArray(raw) && raw.length > VIEW_SOURCES_MAX) {
    issues.add("sources", `at most ${VIEW_SOURCES_MAX} sources`);
    issues.raiseIfAny();
  }
  const parsed = sources(issues, raw, now);
  issues.raiseIfAny();
  return parsed.map(sourceJson);
}

// ------------------------------------------------------------------------------- runs

export interface RunScope {
  readonly held: boolean;
  readonly watchlist: boolean;
  readonly candidates: boolean;
  /** Old free-text themes (kept for stored runs; the MCP scope no longer takes them). */
  readonly themes: readonly string[];
  /** Market segments (catalog keys) an on-demand run covers (P5). */
  readonly segments: readonly string[];
  /** Explicit instrument references (ids, symbols, ISINs); resolved by the service. */
  readonly instruments: readonly string[];
  /** True for the scheduled (Saturday) routine, false on demand. */
  readonly scheduled: boolean;
  /** A full fresh research the owner explicitly asked for (P9). */
  readonly fullRefresh: boolean;
}

const SCOPE_KEYS: readonly string[] = Object.freeze([
  "held",
  "watchlist",
  "candidates",
  "themes",
  "segments",
  "instruments",
  "scheduled",
  "full_refresh",
]);

function getOr(data: JsonObject, key: string, fallback: unknown): unknown {
  return Object.hasOwn(data, key) ? data[key] : fallback;
}

export function validateScope(raw: JsonObject | null | undefined): RunScope {
  const issues = new Issues();
  const data: JsonObject = raw && truthy(raw) ? raw : {};
  if (unknownKeys(data, SCOPE_KEYS).length > 0) {
    issues.add("scope", `allowed keys: ${[...SCOPE_KEYS].sort().join(", ")}`);
  }
  // A scope naming only instruments / segments is on demand: the flags it leaves out default to
  // false (P5: the weekly novelty limits apply to runs covering the held positions only).
  const onDemand = truthy(get(data, "instruments")) || truthy(get(data, "segments"));
  const flags: Record<string, boolean> = {};
  for (const key of ["held", "watchlist", "candidates"]) {
    const fallback = !onDemand;
    let value = getOr(data, key, fallback);
    if (typeof value !== "boolean") {
      issues.add(`scope.${key}`, "must be true or false");
      value = fallback;
    }
    flags[key] = value as boolean;
  }
  let scheduled = getOr(data, "scheduled", false);
  if (typeof scheduled !== "boolean") {
    issues.add("scope.scheduled", "must be true or false");
    scheduled = false;
  }
  let fullRefresh = getOr(data, "full_refresh", false);
  if (typeof fullRefresh !== "boolean") {
    issues.add("scope.full_refresh", "must be true or false");
    fullRefresh = false;
  }
  if (fullRefresh && scheduled) {
    issues.add(
      "scope.full_refresh",
      "a full refresh comes only from the owner's explicit request, never a scheduled run",
    );
  }
  const themes: string[] = [];
  const rawThemes = truthy(get(data, "themes")) ? get(data, "themes") : [];
  if (!Array.isArray(rawThemes) || rawThemes.length > SCOPE_THEMES_MAX) {
    issues.add("scope.themes", `must be a list of at most ${SCOPE_THEMES_MAX} themes`);
  } else {
    rawThemes.forEach((theme: unknown, i) => {
      const value = text(issues, `scope.themes[${i}]`, cleanTheme(pyStr(theme)), {
        minimum: 2,
        maximum: THEME_MAX,
      });
      if (value && !themes.some((t) => pyCasefold(t) === pyCasefold(value))) themes.push(value);
    });
  }
  const segments: string[] = [];
  const rawSegments = truthy(get(data, "segments")) ? get(data, "segments") : [];
  if (!Array.isArray(rawSegments) || rawSegments.length > NOTE_SEGMENT_KEYS.length) {
    issues.add("scope.segments", `must be a list of at most ${NOTE_SEGMENT_KEYS.length} segments`);
  } else {
    rawSegments.forEach((key: unknown, i) => {
      if (!isNoteSegment(key)) {
        issues.add(`scope.segments[${i}]`, `must be one of: ${NOTE_SEGMENT_KEYS.join(", ")}`);
      } else if (!segments.includes(key)) {
        segments.push(key);
      }
    });
  }
  const instruments: string[] = [];
  const rawInstruments = truthy(get(data, "instruments")) ? get(data, "instruments") : [];
  if (!Array.isArray(rawInstruments) || rawInstruments.length > SCOPE_INSTRUMENTS_MAX) {
    issues.add(
      "scope.instruments",
      `must be a list of at most ${SCOPE_INSTRUMENTS_MAX} references`,
    );
  } else {
    rawInstruments.forEach((ref: unknown, i) => {
      // Python `isinstance(ref, str | int)`: bool is an int (`str(True)`).
      const value =
        typeof ref === "string" || isInt(ref) || typeof ref === "boolean"
          ? pyStrip(pyStr(ref))
          : "";
      if (!value || pyLen(value) > 40) {
        issues.add(`scope.instruments[${i}]`, "must be an instrument id, symbol or ISIN");
      } else {
        instruments.push(value);
      }
    });
  }
  issues.raiseIfAny();
  return {
    held: flags.held as boolean,
    watchlist: flags.watchlist as boolean,
    candidates: flags.candidates as boolean,
    themes,
    segments,
    instruments: [...new Set(instruments)],
    scheduled: scheduled as boolean,
    fullRefresh: fullRefresh as boolean,
  };
}

/** Agent-reported counters (`RUN_COUNT_KEYS`), each an integer in [0, 100000]. */
export function validateCounts(raw: JsonObject | null | undefined): Record<string, number> {
  const issues = new Issues();
  const out: Record<string, number> = {};
  const data: JsonObject = raw && truthy(raw) ? raw : {};
  for (const [key, value] of Object.entries(data)) {
    if (!RUN_COUNT_KEYS.includes(key)) {
      issues.add("counts", `allowed keys: ${RUN_COUNT_KEYS.join(", ")}`);
      break;
    }
    if (!isInt(value) || value < 0 || value > COUNT_MAX) {
      issues.add(`counts.${key}`, `must be an integer between 0 and ${COUNT_MAX}`);
      continue;
    }
    out[key] = value;
  }
  issues.raiseIfAny();
  return out;
}
