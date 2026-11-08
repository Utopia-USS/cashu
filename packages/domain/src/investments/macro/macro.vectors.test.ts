/// <reference types="node" />
// Differential tests against Python (vectors recorded by the retired Python app's macro_vectors.py): every
// section replays the synthetic inputs through the TS port and expects the same output.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UiLang } from "../../core/i18n.js";
import { fromOrdinal, type IsoDate, toOrdinal } from "../../dates.js";
import { loadVectors, Mismatches } from "../../testing/vectors.js";
import { formatPct, formatPp } from "./format.js";
import {
  macroStrings,
  metricLabels,
  monthNames,
  plainSentences,
  regimeIntros,
  regimeLabels,
  regimeMeanings,
  regimeRules,
  regimeStateLabels,
  summaryHeads,
} from "./macro.strings.js";
import { MAX_RETRIES, SKIPPED_MESSAGE, TIMEOUT_SECONDS } from "./refresh.js";
import {
  BEAR_DRAWDOWN,
  bondEquivalent,
  COMMODITY_MOVE,
  CORRECTION_DRAWDOWN,
  DOLLAR_MOVE,
  EM_RELATIVE,
  evaluate,
  formatMetric,
  HISTORY_MAX,
  HOLD_SESSIONS,
  INVERTED,
  MA_WINDOW,
  type MacroClose,
  type MacroCloses,
  METRIC_LABELS,
  type MetricUnit,
  MIN_BARS,
  metric,
  ORDER,
  PEAK_WINDOW,
  RATES_MOVE,
  type Regime,
  type RegimeKey,
  regime,
  regimeLabel,
  SIX_MONTHS,
  SLOPE_LAG,
  STALE_DAYS,
  STATE_TONES,
  stateLabel,
  THREE_MONTHS,
  TOLERANCE,
  TWELVE_MONTHS,
  UNKNOWN,
  WEEK_DAYS,
} from "./regimes.js";
import { BACKFILL_DAYS, SERIES, USDPLN } from "./series.js";
import { DIGITS, macroChanges, regimeDict } from "./service.js";
import {
  type CurrencyEffect,
  explain,
  plain,
  SUMMARY_MAX,
  summary,
  summaryOk,
  vocabulary,
} from "./texts.js";

const LANGS: readonly UiLang[] = ["pl", "en"];

function pairsOf(catalog: Readonly<Record<string, { pl: string; en: string }>>, lang: UiLang) {
  return Object.entries(catalog).map(([k, v]) => [k, v[lang]]);
}

/** `<regime>.<state>` catalog -> Python `[[key, [[state, text]]]]`. */
function perState(catalog: Readonly<Record<string, { pl: string; en: string }>>, lang: UiLang) {
  const out: [string, [string, string][]][] = [];
  for (const [id, v] of Object.entries(catalog)) {
    const [key, state] = id.split(".") as [string, string];
    let group = out.find(([k]) => k === key);
    if (group === undefined) {
      group = [key, []];
      out.push(group);
    }
    group[1].push([state, v[lang]]);
  }
  return out;
}

const F = macroStrings;

function tables(): Record<string, unknown> {
  return {
    ORDER: [...ORDER],
    LABELS: pairsOf(regimeLabels, "pl"),
    LABELS_EN: pairsOf(regimeLabels, "en"),
    STATES: perState(regimeStateLabels, "pl").map(([key, states]) => [
      key,
      states.map(([state, label]) => [state, label, STATE_TONES[key as RegimeKey][state]]),
    ]),
    STATES_EN: perState(regimeStateLabels, "en"),
    MEANINGS: perState(regimeMeanings, "pl"),
    MEANINGS_EN: perState(regimeMeanings, "en"),
    FIXED: [
      UNKNOWN,
      F.unknownLabel.pl,
      F.unknownLabel.en,
      INVERTED,
      F.invertedSuffix.pl,
      F.invertedSuffix.en,
      F.unknownMeaning.pl,
      F.unknownMeaning.en,
      F.invertedMeaning.pl,
      F.invertedMeaning.en,
    ],
    METRIC_LABELS: [...METRIC_LABELS].sort(),
    METRIC_LABELS_EN: Object.values(metricLabels).map((e) => [e.pl, e.en]),
    CONSTANTS: [
      MIN_BARS,
      MA_WINDOW,
      SLOPE_LAG,
      PEAK_WINDOW,
      SIX_MONTHS,
      TWELVE_MONTHS,
      THREE_MONTHS,
      HOLD_SESSIONS,
      STALE_DAYS,
      HISTORY_MAX,
      TOLERANCE,
      WEEK_DAYS,
      BEAR_DRAWDOWN,
      CORRECTION_DRAWDOWN,
      DOLLAR_MOVE,
      EM_RELATIVE,
      COMMODITY_MOVE,
      RATES_MOVE,
      SUMMARY_MAX,
      DIGITS,
      BACKFILL_DAYS,
      TIMEOUT_SECONDS,
      MAX_RETRIES,
    ],
    SERIES: SERIES.map((s) => [s.key, s.symbol, s.meaning, s.unit, s.adjusted]),
    USDPLN,
    SKIPPED_MESSAGE,
    MONTHS_GENITIVE: Object.values(monthNames).map((m) => m.pl),
    MONTHS_EN: Object.values(monthNames).map((m) => m.en),
    SUMMARY_FIXED: [
      F.unknownSummary.pl,
      F.unknownSummary.en,
      F.invertedSentence.pl,
      F.invertedSentence.en,
      F.plainInverted.pl,
      F.plainInverted.en,
      F.plainUnknown.pl,
      F.plainUnknown.en,
    ],
    HEADS: perState(summaryHeads, "pl"),
    HEADS_EN: perState(summaryHeads, "en"),
    INTRO: pairsOf(regimeIntros, "pl"),
    INTRO_EN: pairsOf(regimeIntros, "en"),
    RULE: pairsOf(regimeRules, "pl"),
    RULE_EN: pairsOf(regimeRules, "en"),
    PLAIN: perState(plainSentences, "pl"),
    PLAIN_EN: perState(plainSentences, "en"),
    VOCABULARY: [...vocabulary()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/** Python `json.dumps(value, ensure_ascii=False, separators=(",", ":"))` of a table without floats. */
function canon(value: unknown): string {
  return JSON.stringify(value);
}

describe("macro tables (catalog and constants vs Python)", () => {
  it("every table matches the Python source byte for byte", () => {
    const mine = tables();
    const m = new Mismatches();
    const names: string[] = [];
    for (const [name, hash, value] of loadVectors("macro-tables").rows as [
      string,
      string,
      unknown,
    ][]) {
      names.push(name);
      m.check(`${name} value`, mine[name], value);
      if (name !== "CONSTANTS") {
        // CONSTANTS holds floats (Python repr differs from JSON.stringify): compared by value only
        m.check(
          `${name} sha256`,
          createHash("sha256").update(canon(mine[name])).digest("hex"),
          hash,
        );
      }
    }
    expect(names.sort()).toEqual(Object.keys(mine).sort());
    expect(m.items, m.report()).toEqual([]);
  });
});

describe("macro number formats", () => {
  it("format_metric, pct, pp and bond_equivalent agree with Python", () => {
    const m = new Mismatches();
    for (const [kind, lang, value, args, want] of loadVectors("macro-formats").rows as [
      string,
      UiLang,
      number,
      unknown[],
      unknown,
    ][]) {
      let got: unknown;
      if (kind === "metric") {
        const [unit, decimals, suffix] = args as [MetricUnit, number, string];
        got = formatMetric(metric("x", value, unit, { decimals, suffix }), lang);
      } else if (kind === "pct") {
        got = formatPct(value, lang, args[0] as boolean);
      } else if (kind === "pp") {
        got = formatPp(value, lang, args[0] as number);
      } else {
        got = bondEquivalent(value);
      }
      m.check(`${kind} ${lang} ${value} ${JSON.stringify(args)}`, got, want);
    }
    expect(m.checked).toBe(15);
    expect(m.items, m.report()).toEqual([]);
  });
});

// --------------------------------------------------------------------------- series cases

interface SeriesSpec {
  readonly start: IsoDate;
  readonly n: number;
  readonly p0: number;
  readonly segments: readonly (readonly [number, number])[];
  readonly drop?: readonly [number, number];
  readonly zero?: readonly number[];
}

function weekdays(start: IsoDate, n: number): IsoDate[] {
  const out: IsoDate[] = [];
  // Walk ordinals (weekday = (ordinal + 6) % 7, Monday 0) instead of parsing a date text per day.
  for (let ordinal = toOrdinal(start); out.length < n; ordinal++) {
    if ((ordinal + 6) % 7 < 5) out.push(fromOrdinal(ordinal));
  }
  return out;
}

/** `build(spec)` of the generator, with the same float operations. */
function buildCloses(spec: SeriesSpec): MacroClose[] {
  const days = weekdays(spec.start, spec.n);
  const values: number[] = [];
  let value = spec.p0;
  for (const [length, growth] of spec.segments) {
    for (let i = 0; i < length; i++) {
      values.push(value);
      value *= growth;
    }
  }
  const points: [IsoDate, number][] = [];
  days.forEach((day, i) => {
    if (spec.drop !== undefined && i % spec.drop[0] === spec.drop[1]) return;
    points.push([day, values[i] as number]);
  });
  for (const i of spec.zero ?? []) {
    const point = points[i];
    if (point !== undefined) points[i] = [point[0], 0.0];
  }
  return points;
}

function currencyOf(raw: [number, boolean] | null): CurrencyEffect | null {
  return raw === null ? null : { contribution: raw[0], foreign: raw[1] };
}

function withoutExplain(card: object): object {
  const { explain: _explain, ...rest } = card as Record<string, unknown>;
  return rest;
}

describe("macro regimes over synthetic series", () => {
  const rows = loadVectors("macro-cases").rows as [
    Record<string, SeriesSpec>,
    IsoDate,
    [number, boolean] | null,
    object[],
    object[],
    [string, [IsoDate, string, IsoDate, boolean][], number | null][],
    [IsoDate, object[], object[]][],
  ][];

  // The cases in slices of 10 so no single test holds the whole set.
  const PER_SLICE = 10;
  const slices = Array.from({ length: Math.ceil(rows.length / PER_SLICE) }, (_, i) => i);

  it.each(slices)(
    "evaluate + regime_dict + changes agree with Python (slice %i of the cases)",
    (slice) => {
      const m = new Mismatches();
      const from = slice * PER_SLICE;
      rows
        .slice(from, from + PER_SLICE)
        .forEach(([specs, asOf, rawCurrency, pl, en, full, changes], k) => {
          const i = from + k;
          const closes: Record<string, MacroClose[]> = {};
          for (const [key, spec] of Object.entries(specs)) closes[key] = buildCloses(spec);
          const found = evaluate(closes as MacroCloses, asOf);
          const currency = currencyOf(rawCurrency);
          const cards = (lang: UiLang) =>
            found.map((r) =>
              withoutExplain(regimeDict(r, lang, r.key === "dollar" ? currency : null)),
            );
          m.check(`#${i} pl`, cards("pl"), pl);
          m.check(`#${i} en`, cards("en"), en);
          m.check(
            `#${i} history`,
            found.map((r) => [
              r.key,
              r.history.map((h) => [h.date, h.state, h.confirmed, h.open]),
              r.usdpln1w,
            ]),
            full,
          );
          for (const [start, wantPl, wantEn] of changes) {
            m.check(`#${i} changes ${start} pl`, macroChanges(found, start, asOf, "pl"), wantPl);
            m.check(`#${i} changes ${start} en`, macroChanges(found, start, asOf, "en"), wantEn);
          }
        });
      expect(m.checked).toBeGreaterThan(0);
      expect(m.items, m.report()).toEqual([]);
    },
  );
});

// --------------------------------------------------------------------------- texts

type RegimeJson = [
  RegimeKey,
  string,
  IsoDate | null,
  boolean,
  IsoDate | null,
  [string, number, MetricUnit][],
  string[],
  number | null,
  boolean,
];

function regimeOf([
  key,
  state,
  since,
  sinceOpen,
  sinceMin,
  metrics,
  flags,
  usd,
  missing,
]: RegimeJson): Regime {
  const known = Object.hasOwn(regimeMeanings, `${key}.${state}`);
  return regime({
    key,
    label: regimeLabel(key),
    state,
    stateLabel: stateLabel(key, state, "pl"),
    tone: STATE_TONES[key][state] ?? "",
    since,
    metrics: metrics.map(([label, value, unit]) => metric(label, value, unit)),
    asOf: "2026-10-09",
    stale: false,
    missing,
    meaning: known
      ? ((regimeMeanings as Record<string, { pl: string }>)[`${key}.${state}`]?.pl ?? "")
      : macroStrings.unknownMeaning.pl,
    flags,
    sinceOpen,
    sinceMin,
    usdpln1w: usd,
  });
}

describe("macro card texts", () => {
  it("summary, plain, explain and summary_ok agree with Python in both languages", () => {
    const m = new Mismatches();
    const rows = loadVectors("macro-texts").rows as [
      RegimeJson,
      [number, boolean] | null,
      [string, string, string | null],
      [string, string, string | null],
      [boolean, boolean],
    ][];
    rows.forEach(([raw, rawCurrency, pl, en, ok], i) => {
      const r = regimeOf(raw);
      const currency = currencyOf(rawCurrency);
      LANGS.forEach((lang, j) => {
        const want = j === 0 ? pl : en;
        m.check(`#${i} ${lang} summary`, summary(r, lang, currency), want[0]);
        m.check(`#${i} ${lang} plain`, plain(r, lang), want[1]);
        if (want[2] !== null) m.check(`#${i} ${lang} explain`, explain(r, lang), want[2]);
      });
      m.check(`#${i} summary_ok`, [summaryOk(pl[0]), summaryOk(en[0])], ok);
    });
    expect(m.items, m.report()).toEqual([]);
  });

  it("summary_ok over mutated texts agrees with Python", () => {
    const m = new Mismatches();
    const rows = loadVectors("macro-summary-ok").rows as [string, boolean][];
    rows.forEach(([text, want], i) => {
      m.check(`#${i}`, summaryOk(text), want);
    });
    expect(m.items, m.report()).toEqual([]);
  });
});
