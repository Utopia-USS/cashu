/**
 * Market calendar of the weekly review, the pure part (`market/calendar.py`): what happens in the next
 * `DAYS` days.
 *
 * Three sources, merged into one list of dated events:
 * - **Macro** - ForexFactory's public weekly feed: only high-impact releases of the big economies
 *   (`countryLabels`); central-bank meetings are folded into one "decyzja o stopach" row per bank and
 *   day, the common releases get a Polish name. The cache stores the Polish `title` next to the feed's
 *   English `source_title` and `country`; `calendarEvents` renders the title and country label again
 *   in the UI language.
 * - **Earnings** - Nasdaq's public daily earnings list, matched *locally* to the profile's held and
 *   watched US-listed instruments.
 * - **Research** - events the research agent stored on a note (`details.event_date` / `event`).
 *
 * Privacy: both feeds are fetched as whole public lists; no symbol, amount or profile detail is sent.
 * The fetching and the device-local cache are `@cashu/market` `fetchFeeds` / `feeds`; the cache JSON
 * keeps Python's wire names (`fetched_at`, `from`, `to`, `macro`, `earnings`, `errors`).
 */

import type { UiLang } from "../../core/i18n.js";
import {
  addDays,
  type DateTime,
  daysBetween,
  fromIsoFormat,
  parseDateTime,
  weekday,
} from "../../dates.js";
import { isRecord, parsePyJson } from "../../pyJson.js";
import { pyRegex } from "../../pyRegex.js";
import { pyLower, pyStrip, pyUpper } from "../../text.js";
import { comparePyStr } from "../domain/values.js";
import { segmentLabel } from "../research/segments.js";
import { calendarStrings, centralBanks, countryLabels, releaseNames } from "./calendar.strings.js";

export const DAYS = 14;
/** How long a complete fetch is served from the cache. */
export const CACHE_TTL_SECONDS = 6 * 3600;
/** How long a fetch with a failed part is served before it is retried. */
export const RETRY_AFTER_SECONDS = 30 * 60;

export const US_MICS: ReadonlySet<string> = new Set([
  "XNAS",
  "XNYS",
  "ARCX",
  "BATS",
  "XASE",
  "XNGS",
  "XNCM",
  "XNMS",
  "IEXG",
]);

type Country = keyof typeof countryLabels;
const isCountry = (value: unknown): value is Country =>
  typeof value === "string" && Object.hasOwn(countryLabels, value);

const RATE_MEETING = pyRegex(
  "(?i)(funds rate|refinancing rate|policy rate|bank rate|rate statement|policy statement|press conference|" +
    "outlook report|monetary policy report|rate votes|fomc statement|loan prime rate)",
);

/** Ordered (Python pattern, release key) of the common high-impact releases; the first match wins. */
const RELEASES: readonly (readonly [RegExp, keyof typeof releaseNames])[] = (
  [
    ["fomc meeting minutes|monetary policy meeting minutes|account of monetary", "minutes"],
    [
      "non-farm|unemployment rate|average hourly earnings|employment change|claimant count",
      "labor",
    ],
    ["core pce", "pce"],
    ["\\bcpi\\b|consumer price|hicp", "cpi"],
    ["\\bppi\\b|producer price", "ppi"],
    ["\\bgdp\\b", "gdp"],
    ["retail sales", "retail"],
    ["ism manufacturing|manufacturing pmi", "pmiManufacturing"],
    ["ism services|services pmi", "pmiServices"],
    ["speaks|testifies", "speech"],
    ["budget", "budget"],
  ] as const
).map(([pattern, key]) => [pyRegex(`(?i)${pattern}`), key] as const);

const PERIOD =
  "(kw\\.|kwarta\\w*|roczn\\w*|półroczn\\w*|polroczn\\w*|okresow\\w*|finansow\\w*|q[1-4]\\b|quarter\\w*|annual|fiscal)";

/**
 * A research event that names a company's periodic (quarterly / annual) results, which the earnings
 * feed has; trial results, vote results or a tender's result are other events and stay (`_RESULTS`).
 */
export const RESULTS = pyRegex(
  `(?i)\\bwyniki\\b.*${PERIOD}|\\b(raport|sprawozdani)\\w*\\b.*${PERIOD}` +
    `|\\b(results|report|earnings)\\b.*${PERIOD}|${PERIOD}.*\\b(results|report|earnings)\\b|\\bearnings\\b`,
);

/** Invalid calendar input (message safe to show). */
export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

/** One high-impact release in the cache (`title` in Polish). */
export interface MacroRow {
  readonly date: string;
  readonly time: string | null;
  readonly country: string;
  readonly title: string;
  readonly source_title?: string;
}

/** One company reporting on a day. */
export interface EarningsRow {
  readonly date: string;
  readonly symbol: string;
  readonly name: string;
  readonly when: "pre" | "after" | null;
}

/** The cached feeds (Python's cache JSON). */
export interface CalendarFeeds {
  readonly fetched_at: string | null;
  readonly from: string;
  readonly to: string;
  readonly macro: readonly MacroRow[];
  readonly earnings: readonly EarningsRow[];
  readonly errors: readonly string[];
}

// ---- parsing -------------------------------------------------------------------------------------

/**
 * The name of a high-impact release in `lang` (Polish in the cache), the feed's English title when it
 * is not a known one (`macro_name`).
 */
export function macroName(country: string, title: string, lang: UiLang): string {
  if (RATE_MEETING.test(title) && !pyLower(title).includes("unemployment")) {
    const bank = Object.hasOwn(centralBanks, country)
      ? centralBanks[country as Country][lang]
      : country;
    return calendarStrings.rateDecision[lang](bank);
  }
  for (const [pattern, key] of RELEASES) {
    if (pattern.test(title)) return releaseNames[key][lang];
  }
  return title;
}

/** A local wall time: the calendar day and `HH:MM` of an instant in the device's time zone. */
export interface LocalTime {
  readonly date: string;
  readonly time: string;
}

/**
 * Python `datetime.astimezone()` + `strftime`: an aware time in the device's zone; a naive time is
 * taken as already local. Injected (the domain has no time zone database).
 */
export type ToLocalTime = (moment: DateTime) => LocalTime;

/** Python `datetime.fromisoformat` for the feed's dates (a bare date is midnight). */
function parseFeedMoment(text: string): DateTime {
  try {
    return parseDateTime(text);
  } catch (error) {
    try {
      return {
        date: fromIsoFormat(text),
        hour: 0,
        minute: 0,
        second: 0,
        microsecond: 0,
        offsetSeconds: null,
      };
    } catch {
      throw error;
    }
  }
}

/** Python truthiness of a parsed JSON value. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `str(value)` of a parsed JSON scalar. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** High-impact releases of the big economies from one ForexFactory weekly feed, in local time (`parse_ff`). */
export function parseFf(body: string, toLocal: ToLocalTime): MacroRow[] {
  const rows = parsePyJson(body);
  if (!Array.isArray(rows)) throw new TypeError("ForexFactory feed is not a list");
  const out: MacroRow[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row.impact !== "High" || !isCountry(row.country)) continue;
    if (!("date" in row)) continue;
    let local: LocalTime;
    try {
      local = toLocal(parseFeedMoment(pyStr(row.date)));
    } catch {
      continue;
    }
    const title = pyStrip(pyTruthy(row.title) ? pyStr(row.title) : "");
    out.push({
      date: local.date,
      time: local.time,
      country: row.country,
      title: macroName(row.country, title, "pl"),
      source_title: title,
    });
  }
  return out;
}

/** Companies reporting on `day` (symbol, name, before / after the session) (`parse_nasdaq`). */
export function parseNasdaq(body: string, day: string): EarningsRow[] {
  const parsed = parsePyJson(body);
  if (!isRecord(parsed)) throw new TypeError("Nasdaq answer is not an object");
  const data = pyTruthy(parsed.data) ? parsed.data : {};
  if (!isRecord(data)) throw new TypeError("Nasdaq data is not an object");
  const rows = pyTruthy(data.rows) ? data.rows : [];
  if (!Array.isArray(rows)) throw new TypeError("Nasdaq rows are not a list");
  const out: EarningsRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new TypeError("Nasdaq row is not an object");
    const symbol = pyUpper(pyStrip(pyTruthy(row.symbol) ? pyStr(row.symbol) : ""));
    if (symbol === "") continue;
    const when = pyTruthy(row.time) ? pyStr(row.time) : "";
    out.push({
      date: day,
      symbol,
      name: pyStrip(pyTruthy(row.name) ? pyStr(row.name) : ""),
      when: when.includes("pre") ? "pre" : when.includes("after") ? "after" : null,
    });
  }
  return out;
}

/** Rows with a distinct `keys` tuple, the first one kept (`_unique`). */
export function uniqueRows<T extends object>(rows: Iterable<T>, keys: readonly (keyof T)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k] ?? null));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** The weekdays among `start .. start + days - 1` (`_weekdays`). */
export function weekdaysFrom(start: string, days: number): string[] {
  const out: string[] = [];
  for (let n = 0; n < days; n++) {
    const day = addDays(start, n);
    if (weekday(day) < 5) out.push(day);
  }
  return out;
}

// ---- the cache -----------------------------------------------------------------------------------

/** Epoch seconds of an aware timestamp. */
function epochSeconds(moment: DateTime): number {
  const offset = moment.offsetSeconds ?? 0;
  return (
    daysBetween("1970-01-01", moment.date) * 86400 +
    moment.hour * 3600 +
    moment.minute * 60 +
    moment.second +
    moment.microsecond / 1e6 -
    offset
  );
}

/**
 * Young enough and covering the range; a fetch with errors is retried after `RETRY_AFTER_SECONDS`
 * (`_fresh`). `now` is an aware timestamp.
 */
export function isFresh(
  data: unknown,
  today: string,
  days: number,
  now: DateTime,
): data is CalendarFeeds {
  if (!isRecord(data)) return false;
  let fetched: DateTime;
  let start: string;
  let end: string;
  try {
    if (
      typeof data.fetched_at !== "string" ||
      typeof data.from !== "string" ||
      typeof data.to !== "string"
    ) {
      return false;
    }
    fetched = parseDateTime(data.fetched_at);
    start = fromIsoFormat(data.from);
    end = fromIsoFormat(data.to);
  } catch {
    return false;
  }
  if (fetched.offsetSeconds === null) return false; // Python: naive minus aware is a TypeError
  const ttl = isNonEmpty(data.errors) ? RETRY_AFTER_SECONDS : CACHE_TTL_SECONDS;
  return (
    epochSeconds(now) - epochSeconds(fetched) < ttl && start <= today && end >= addDays(today, days)
  );
}

/** Python truthiness of a cached value. */
function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value !== "";
  return Boolean(value);
}

/** The feeds nothing was fetched for (`_empty`). */
export function emptyFeeds(today: string, days: number, errors: readonly string[]): CalendarFeeds {
  return {
    fetched_at: null,
    from: today,
    to: addDays(today, days),
    macro: [],
    earnings: [],
    errors: [...errors],
  };
}

/**
 * A fresh fetch stamped `fetchedAt`, keeping the previous cache's rows for a part that failed
 * (`feeds`: "keep what the old cache had for the failed part").
 */
export function mergeFetched(
  got: CalendarFeeds,
  cached: unknown,
  fetchedAt: string,
): CalendarFeeds {
  let macro = got.macro;
  let earnings = got.earnings;
  if (isRecord(cached) && got.errors.length > 0) {
    if (macro.length === 0) macro = Array.isArray(cached.macro) ? (cached.macro as MacroRow[]) : [];
    if (earnings.length === 0) {
      earnings = Array.isArray(cached.earnings) ? (cached.earnings as EarningsRow[]) : [];
    }
  }
  return { ...got, macro, earnings, fetched_at: fetchedAt };
}

/** Python `bool(feeds.get("errors"))`: part of the last fetch failed. */
export function isStale(data: CalendarFeeds): boolean {
  return data.errors.length > 0;
}

// ---- the profile's view --------------------------------------------------------------------------

/** A held or watched instrument of the profile, as the calendar needs it. */
export interface CalendarInstrument {
  readonly id: string;
  readonly name: string;
  readonly symbol: string | null;
  readonly mic: string | null;
  /** The owner's own label, when set. */
  readonly label: string | null;
  /** The instrument's yahoo alias. */
  readonly yahoo: string | null;
  readonly held: boolean;
}

/** A research note with its stored event, as the calendar needs it. */
export interface CalendarNote {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly instrumentId: string | null;
  readonly segment: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface CalendarEvent {
  readonly date: string;
  readonly time: string | null;
  readonly kind: "macro" | "earnings" | "research";
  readonly title: string;
  readonly country: string | null;
  readonly country_label: string | null;
  readonly instrument_id: string | null;
  readonly label: string | null;
  readonly held: boolean | null;
  readonly note_id: string | null;
}

export interface CalendarView {
  readonly as_of: string;
  readonly from: string;
  readonly to: string;
  readonly fetched_at: string | null;
  readonly stale: boolean;
  readonly errors: readonly string[];
  readonly events: readonly CalendarEvent[];
}

/** `days` must be 1..31 (`CalendarError` otherwise). */
export function checkCalendarDays(days: number): void {
  if (!(days >= 1 && days <= 31)) throw new CalendarError("days must be between 1 and 31");
}

/** The bare US ticker of an instrument (`NVDA`), null when it is not US-listed (`_us_symbol`). */
export function usSymbol(instrument: CalendarInstrument): string | null {
  const yahoo = instrument.yahoo;
  if (yahoo && !yahoo.includes(".") && !yahoo.includes("=") && !yahoo.includes("^"))
    return pyUpper(yahoo);
  const symbol = pyUpper(pyStrip(instrument.symbol ?? ""));
  if (symbol === "") return null;
  if (symbol.endsWith(".US")) return symbol.slice(0, -3);
  if (US_MICS.has(pyUpper(instrument.mic ?? "")) && !symbol.includes(".")) return symbol;
  return null;
}

function labelOf(instrument: CalendarInstrument): string {
  return instrument.label || instrument.symbol || instrument.name;
}

const firstChars = (text: string, n: number): string => Array.from(text).slice(0, n).join("");

export interface CalendarInput {
  readonly feeds: CalendarFeeds;
  readonly stale: boolean;
  readonly today: string;
  readonly days?: number;
  /** Held and watched instruments of the profile. */
  readonly instruments: readonly CalendarInstrument[];
  /** The profile's research notes, newest first. */
  readonly notes: readonly CalendarNote[];
  readonly lang: UiLang;
}

const RANK: Readonly<Record<string, number>> = { earnings: 0, macro: 1, research: 2 };

/**
 * The next `days` days for one profile: macro releases, earnings of its held / watched US instruments
 * and its research notes' events, sorted by date and time (`calendar_view` without the store reads).
 */
export function calendarEvents(input: CalendarInput): CalendarView {
  const days = input.days ?? DAYS;
  checkCalendarDays(days);
  const { feeds, today, lang } = input;
  const end = addDays(today, days);
  const inRange = (day: string) => today <= day && day < end;

  const events: CalendarEvent[] = [];
  for (const m of feeds.macro) {
    if (!inRange(m.date)) continue;
    events.push({
      date: m.date,
      time: m.time ?? null,
      kind: "macro",
      title: m.source_title ? macroName(m.country, m.source_title, lang) : m.title,
      country: m.country,
      country_label: isCountry(m.country) ? countryLabels[m.country][lang] : m.country,
      instrument_id: null,
      label: null,
      held: null,
      note_id: null,
    });
  }

  const byId = new Map(input.instruments.map((i) => [i.id, i]));
  const bySymbol = new Map<string, CalendarInstrument>();
  for (const instrument of byId.values()) {
    const symbol = usSymbol(instrument);
    if (symbol) bySymbol.set(symbol, instrument);
  }
  for (const e of feeds.earnings) {
    const hit = bySymbol.get(e.symbol);
    if (hit === undefined || !inRange(e.date)) continue;
    const label = labelOf(hit);
    events.push({
      date: e.date,
      time:
        e.when === "pre"
          ? calendarStrings.beforeOpen[lang]
          : e.when === "after"
            ? calendarStrings.afterClose[lang]
            : null,
      kind: "earnings",
      title: calendarStrings.quarterlyResults[lang](label),
      country: null,
      country_label: null,
      instrument_id: hit.id,
      label,
      held: hit.held,
      note_id: null,
    });
  }

  const feedEarnings = new Set(
    events.filter((e) => e.kind === "earnings").map((e) => `${e.instrument_id}\u0000${e.date}`),
  );
  const seen = new Set<string>();
  for (const note of input.notes) {
    const details = note.details ?? {};
    const when = details.event_date;
    if (typeof when !== "string") continue;
    const day = firstChars(when, 10);
    if (!inRange(day)) continue;
    const title = pyTruthy(details.event) ? pyStr(details.event) : note.title;
    // The feed already has this report; several notes pointing at one event show it once.
    if (
      feedEarnings.has(`${note.instrumentId}\u0000${day}`) &&
      (note.kind === "earnings" || RESULTS.test(title))
    ) {
      continue;
    }
    const key = JSON.stringify([day, note.instrumentId, note.segment, pyLower(pyStrip(title))]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instrument = note.instrumentId === null ? undefined : byId.get(note.instrumentId);
    events.push({
      date: day,
      time: null,
      kind: "research",
      title,
      country: null,
      country_label: note.segment ? segmentLabel(note.segment, lang) : null,
      instrument_id: note.instrumentId,
      label: instrument ? labelOf(instrument) : null,
      held: instrument ? instrument.held : null,
      note_id: note.id,
    });
  }

  events.sort(
    (a, b) =>
      comparePyStr(a.date, b.date) ||
      (RANK[a.kind] ?? 3) - (RANK[b.kind] ?? 3) ||
      comparePyStr(a.time || "99", b.time || "99"),
  );
  return {
    as_of: today,
    from: today,
    to: end,
    fetched_at: feeds.fetched_at,
    stale: input.stale,
    errors: [...feeds.errors],
    events,
  };
}
