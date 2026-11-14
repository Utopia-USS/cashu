/**
 * Human texts of the macro regime cards (`macro/texts.py`, P7).
 *
 * - `summary`: one or two short sentences built deterministically from the state, `since` and the
 *   metrics, in plain words (at most `SUMMARY_MAX` characters: a card's secondary detail gives way
 *   first, then the `since` phrase, which the card also shows next to its title); the dollar card may
 *   fold in the portfolio's currency effect of the week (`CurrencyEffect`).
 * - `explain`: the full hover text: what the cycle / indicator is (static), how the app measures it
 *   (the rule in plain words), then the current state and its meaning.
 * - `plain`: one beginner sentence per state (P9).
 *
 * Register: present facts, past facts and "zwykle" (what usually went together); never a statement
 * about a future price. `summaryOk` tells whether a text could have come from `summary` (only its
 * Polish vocabulary plus numbers): the MCP layer lets nothing else through as public market text, so
 * an English text fails closed.
 */

import type { UiLang } from "../../core/i18n.js";
import { type IsoDate, parseDate } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { pyRegex } from "../../pyRegex.js";
import { pyLen } from "../../text.js";
import { InvariantError } from "../domain/values.js";
import { textsOf } from "./entry.js";
import { formatNumber, formatPct, formatPp, formatSigned, pctRoundsToZero } from "./format.js";
import {
  macroStrings,
  metricLabels,
  monthNames,
  plainSentences,
  regimeIntros,
  regimeRules,
  summaryHeads,
} from "./macro.strings.js";
import {
  displayMeaning,
  displayStateLabel,
  INVERTED,
  METRIC_LABELS,
  metric,
  ORDER,
  type Regime,
  type RegimeKey,
  regime,
  regimeLabel,
  STATE_TONES,
  stateLabel,
  UNKNOWN,
} from "./regimes.js";

/**
 * Maximum length of a summary in code points (the dollar card drops its half-year detail, the rates
 * card its 3-month change, then any card its `since` phrase to stay within it).
 */
export const SUMMARY_MAX = 140;

/** The portfolio's currency effect over the last week (the 1w segment attribution). */
export interface CurrencyEffect {
  /** Fraction of the portfolio's value (0.006 = 0,6 pp). */
  readonly contribution: number;
  /** The portfolio held foreign-currency assets at the start of the week. */
  readonly foreign: boolean;
}

const MONTHS = Object.values(monthNames);
const L = metricLabels;
const S = macroStrings;

// --------------------------------------------------------------------------- formatting

/** `maja 2025` (genitive, after `od`); `May 2025` in English. */
export function monthText(day: IsoDate, lang: UiLang): string {
  const { year, month } = parseDate(day);
  return `${MONTHS[month - 1]?.[lang]} ${year}`;
}

/**
 * `od maja 2025`; `co najmniej od października 2021` for an open-ended state; empty when unknown.
 * English: `since May 2025`, `since at least October 2021`.
 */
export function sincePhrase(r: Regime, lang: UiLang): string {
  if (r.since !== null) return S.since[lang](monthText(r.since, lang));
  if (r.sinceOpen && r.sinceMin !== null) return S.sinceAtLeast[lang](monthText(r.sinceMin, lang));
  return "";
}

function metricValue(r: Regime, label: string): number | null {
  return r.metrics.find((m) => m.label === label)?.value ?? null;
}

function sentence(head: string, since: string, detail = ""): string {
  const text = head + (since ? ` ${since}` : "");
  return `${text}${detail ? `: ${detail}` : ""}.`;
}

/** `o 6,2 pp więcej niż akcje globalne` (`tyle samo co` when it rounds to 0). */
function versus(diffPp: number | null, other: string, lang: UiLang): string {
  if (diffPp === null) return "";
  if (roundFloat(diffPp, 1) === 0) return S.versusSame[lang](other);
  const pp = formatPp(Math.abs(diffPp), lang);
  return diffPp > 0 ? S.versusMore[lang](pp, other) : S.versusLess[lang](pp, other);
}

function join(...parts: string[]): string {
  return parts.filter((p) => p).join(", ");
}

function head(r: Regime, lang: UiLang): string {
  const found = textsOf(summaryHeads, `${r.key}.${r.state}`);
  if (found === null) throw new InvariantError(`no summary head for ${r.key}.${r.state}`);
  return found[lang];
}

// --------------------------------------------------------------------------- summaries

function riskSummary(r: Regime, since: string, lang: UiLang): string {
  const dd = metricValue(r, L.fromPeak.pl);
  let peak = "";
  if (dd !== null) {
    peak = pctRoundsToZero(dd)
      ? S.atYearlyPeak[lang]
      : S.belowYearlyPeak[lang](formatPct(dd, lang, false));
  }
  let detail: string;
  if (r.state === "weak") detail = peak ? S.riskWeakPeakDetail[lang](peak) : S.riskWeakDetail[lang];
  else detail = peak ? S.riskPeakDetail[lang](peak) : "";
  return sentence(head(r, lang), since, detail);
}

function weekText(r: Regime, currency: CurrencyEffect | null, lang: UiLang): string {
  const move = r.usdpln1w;
  let effect = "";
  if (currency?.foreign) {
    const value = currency.contribution * 100;
    if (roundFloat(value, 1) === 0) effect = S.currencyBarelyChanged[lang];
    else if (value > 0) effect = S.currencyAdded[lang](formatPp(value, lang));
    else effect = S.currencyTook[lang](formatPp(Math.abs(value), lang));
  }
  if (move === null && !effect) return "";
  if (move === null) return S.weekEffect[lang](effect);
  if (!effect) return S.weekMove[lang](formatPct(move, lang));
  return S.weekMoveAndEffect[lang](formatPct(move, lang), effect);
}

function dollarSummary(
  r: Regime,
  since: string,
  currency: CurrencyEffect | null,
  lang: UiLang,
): string {
  const six = metricValue(r, L.dxy6m.pl);
  const detail = six === null ? "" : S.dollarSixMonths[lang](formatPct(six, lang));
  const week = weekText(r, currency, lang);
  const full = [sentence(head(r, lang), since, detail), week].filter((p) => p).join(" ");
  if (pyLen(full) <= SUMMARY_MAX || !week) return full;
  return `${sentence(head(r, lang), since)} ${week}`;
}

function emSummary(r: Regime, since: string, lang: UiLang): string {
  const eem = metricValue(r, L.eem6m.pl);
  const diff = metricValue(r, L.eemVsAcwi6m.pl);
  const detail = join(
    eem === null ? "" : S.emSixMonths[lang](formatPct(eem, lang)),
    versus(diff, S.globalStocksEm[lang], lang),
  );
  return sentence(head(r, lang), since, detail);
}

function commoditiesSummary(r: Regime, since: string, lang: UiLang): string {
  const year = metricValue(r, L.dbc12m.pl);
  const diff = metricValue(r, L.dbcVsAcwi12m.pl);
  const detail = join(
    year === null ? "" : S.commoditiesYear[lang](formatPct(year, lang)),
    versus(diff, S.globalStocksCommodities[lang], lang),
  );
  return sentence(head(r, lang), since, detail);
}

function ratesSummary(r: Regime, since: string, lang: UiLang): string {
  const level = metricValue(r, L.us10y.pl);
  const change = metricValue(r, L.us10y3mChange.pl);
  const levelText = level === null ? "" : S.ratesLevel[lang](formatNumber(level, 2, lang));
  const changeText =
    change === null ? "" : S.ratesChange[lang](formatSigned(change / 100, 2, lang));
  const opening = head(r, lang);
  const inverted = S.invertedSentence[lang];
  let text = sentence(opening, since, join(levelText, changeText));
  if (r.flags.includes(INVERTED)) {
    text = `${text} ${inverted}`;
    if (pyLen(text) > SUMMARY_MAX) {
      // the 3-month change gives way to the curve
      text = `${sentence(opening, since, levelText)} ${inverted}`;
    }
  }
  return text;
}

function summaryWith(
  r: Regime,
  since: string,
  currency: CurrencyEffect | null,
  lang: UiLang,
): string {
  switch (r.key) {
    case "risk":
      return riskSummary(r, since, lang);
    case "dollar":
      return dollarSummary(r, since, currency, lang);
    case "em":
      return emSummary(r, since, lang);
    case "commodities":
      return commoditiesSummary(r, since, lang);
    default:
      return ratesSummary(r, since, lang);
  }
}

/**
 * The card's short text (module doc). `currency`: the portfolio's currency effect of the week, folded
 * into the dollar card only.
 */
export function summary(r: Regime, lang: UiLang, currency: CurrencyEffect | null = null): string {
  if (r.missing || r.state === UNKNOWN) return S.unknownSummary[lang];
  const since = sincePhrase(r, lang);
  let text = summaryWith(r, since, currency, lang);
  if (pyLen(text) > SUMMARY_MAX && since) {
    // a long `since` (`co najmniej od października 2025`) gives way first: the card shows the
    // state's start next to its title anyway, and an open-ended state never reads as a known start
    text = summaryWith(r, "", currency, lang);
  }
  return text;
}

// --------------------------------------------------------------------------- plain sentences, explanations

/**
 * The beginner sentence of the regime's state, deterministic: the state only (plus the inverted-curve
 * flag of the rates card), no numbers from the data.
 */
export function plain(r: Regime, lang: UiLang): string {
  const unknown = S.plainUnknown[lang];
  if (r.missing) return unknown;
  const text = textsOf(plainSentences, `${r.key}.${r.state}`)?.[lang];
  if (text === undefined) return unknown;
  return r.flags.includes(INVERTED) ? `${text} ${S.plainInverted[lang]}` : text;
}

/** The card's hover text: the intro, the rule, then the current state and its meaning. */
export function explain(r: Regime, lang: UiLang): string {
  const now = S.explainNow[lang](displayStateLabel(r, lang), displayMeaning(r, lang));
  return `${regimeIntros[r.key][lang]} ${regimeRules[r.key][lang]} ${now}`;
}

// --------------------------------------------------------------------------- vocabulary check (MCP)

const WORD = pyRegex("[^\\W\\d_]+", "g");
const ALLOWED = pyRegex("^[\\w\\s%+\\-,.:/]*$");
const LONG_NUMBER = pyRegex("\\d{5,}");

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

function buildVocabulary(): ReadonlySet<string> {
  const out = new Set<string>(MONTHS.map((m) => m.pl));
  const day = "2025-05-02";
  const currencies: (CurrencyEffect | null)[] = [
    null,
    { contribution: 0.006, foreign: true },
    { contribution: -0.004, foreign: true },
    { contribution: 0.0, foreign: true },
    { contribution: 0.006, foreign: false },
  ];
  const sinces: [IsoDate | null, boolean, IsoDate | null][] = [
    [day, false, null],
    [null, true, day],
    [null, false, null],
  ];
  const labels = [...METRIC_LABELS].sort();
  for (const key of ORDER) {
    for (const [state, tone] of Object.entries(STATE_TONES[key])) {
      for (const value of [0.05, -0.05, 0.0, 0.5]) {
        for (const [since, sinceOpen, sinceMin] of sinces) {
          for (const flags of [[], [INVERTED]]) {
            for (const currency of currencies) {
              for (const usd of [null, 0.006]) {
                const r = regime({
                  key: key as RegimeKey,
                  label: regimeLabel(key),
                  state,
                  stateLabel: stateLabel(key, state, "pl"),
                  tone,
                  since,
                  metrics: labels.map((label) => metric(label, value, "pct")),
                  asOf: day,
                  stale: false,
                  missing: false,
                  meaning: "",
                  flags,
                  sinceOpen,
                  sinceMin,
                  usdpln1w: usd,
                });
                for (const w of words(summary(r, "pl", currency))) out.add(w);
                for (const w of words(summary({ ...r, metrics: [] }, "pl", currency))) out.add(w);
              }
            }
          }
        }
      }
    }
  }
  for (const w of words(S.unknownSummary.pl)) out.add(w);
  return out;
}

let vocabularyCache: ReadonlySet<string> | null = null;

/**
 * Every word `summary` can write in Polish: generated over every state, `since` kind, metric sign,
 * flag and currency variant (numbers are not words). Always Polish (the MCP output is Polish).
 */
export function vocabulary(): ReadonlySet<string> {
  vocabularyCache ??= buildVocabulary();
  return vocabularyCache;
}

/**
 * `summaryOk` over a given vocabulary: true when `text` uses only those words, numbers and the
 * summary's punctuation (at most `2 * summaryMax` code points, ends with a full stop, no run of 5+
 * digits, at least 3 words).
 */
export function summaryChecker(
  words_: ReadonlySet<string>,
  summaryMax: number = SUMMARY_MAX,
): (text: unknown) => boolean {
  return (text: unknown): boolean => {
    if (typeof text !== "string" || pyLen(text) > 2 * summaryMax || !ALLOWED.test(text)) {
      return false;
    }
    if (!text.endsWith(".") || LONG_NUMBER.test(text)) return false;
    const found = words(text);
    return found.length >= 3 && found.every((w) => words_.has(w));
  };
}

/**
 * True when `text` uses only `summary`'s Polish vocabulary, numbers and its punctuation (the MCP lets
 * a macro summary through as public market text only then).
 */
export function summaryOk(text: unknown): boolean {
  return summaryChecker(vocabulary())(text);
}
