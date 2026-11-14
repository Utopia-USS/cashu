/**
 * Macro regimes (`macro/regimes.py`, P6): five deterministic states computed from public reference
 * series.
 *
 * Input: daily closes per series key (`SERIES_KEYS` plus `USDPLN`), any order, and `asOf` (bars dated
 * later are ignored). Output: one `Regime` per card in `ORDER`.
 *
 * Terms: a session is a bar of the series a regime reads; `ma200` = the simple mean of the last 200
 * closes; `chg(n)` = close / close `n` sessions ago - 1. A regime needs `MIN_BARS` sessions, else it
 * is `unknown` / `missing`. Ratios (EM vs the world, commodities vs the world) and the yield curve use
 * the dates both series have (mismatched calendars are aligned, never forward-filled).
 *
 * Hysteresis: the raw state is evaluated for every session from the first one with `MIN_BARS`
 * sessions of history (over every stored bar, never a sliding window); that first raw state is
 * reported at once, after that the reported state switches only when a new raw state held
 * `HOLD_SESSIONS` consecutive sessions: `since` is the first session of that run, `confirmed` the
 * session the switch became visible (the 5th). The first run began before the data: it is open-ended
 * (`since` null, `sinceOpen`, `sinceMin` = the first evaluated session). The yield-curve inversion
 * flag follows the same rule on its own (common) dates.
 *
 * Staleness: a regime is stale when its last bar is more than `STALE_DAYS` calendar days older than
 * `asOf`; every metric carries its own `stale`, and the inversion flag is dropped when the common
 * us10y / us3m date is stale. The 13-week bill yield (`^IRX`, discount basis) is converted to a
 * bond-equivalent yield before the curve. Threshold comparisons treat values within a relative
 * `TOLERANCE` as equal.
 *
 * Language: a `Regime` keeps the Polish labels (`label`, `stateLabel`, `meaning`, metric `label`):
 * they are its identity (the MCP allow-list, the texts' metric lookups). The UI texts come from
 * `displayLabel`, `stateLabel`, `displayStateLabel`, `displayMeaning`, `metricLabel` and
 * `formatMetric` in the language the caller passes. Floats, as in Python.
 */

import type { UiLang } from "../../core/i18n.js";
import { addDays, daysBetween, type IsoDate } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { InvariantError } from "../domain/values.js";
import { textsOf } from "./entry.js";
import { formatNumber, formatSigned } from "./format.js";
import {
  macroStrings,
  metricLabels,
  regimeLabels,
  regimeMeanings,
  regimeStateLabels,
} from "./macro.strings.js";
import { USDPLN } from "./series.js";

export type MetricUnit = "pct" | "pp" | "bp" | "level";
export type Tone = "pos" | "neg" | "warn" | "";
export type RegimeKey = "risk" | "dollar" | "em" | "commodities" | "rates";

export const ORDER: readonly RegimeKey[] = Object.freeze([
  "risk",
  "dollar",
  "em",
  "commodities",
  "rates",
]);

/** Sessions a regime needs (200 for the mean + 20 for its slope, 252 for the yearly peak / change). */
export const MIN_BARS = 260;
/** Sessions in the long moving average. */
export const MA_WINDOW = 200;
/** The mean's slope compares today's ma200 with the one this many sessions ago. */
export const SLOPE_LAG = 20;
/** Sessions (about a year) of the peak the equity drawdown is measured from. */
export const PEAK_WINDOW = 252;
export const SIX_MONTHS = 126;
export const TWELVE_MONTHS = 252;
export const THREE_MONTHS = 63;
/** Consecutive sessions a new raw state must hold before the reported state switches. */
export const HOLD_SESSIONS = 5;
/** A regime is stale when its last bar is more than this many calendar days older than `asOf`. */
export const STALE_DAYS = 5;
/** State runs the API shows from `Regime.history` (newest last). */
export const HISTORY_MAX = 12;
/** Relative tolerance of threshold comparisons (floating point noise). */
export const TOLERANCE = 1e-9;
export const WEEK_DAYS = 7;

/** Equity bear market: ACWI at least 20 % below its 252-session peak. */
export const BEAR_DRAWDOWN = -0.2;
/** Equity correction: ACWI 10-20 % below its peak. */
export const CORRECTION_DRAWDOWN = -0.1;
/** Dollar trend: DXY 6-month change beyond +/- 3 % (and on the same side of its ma200). */
export const DOLLAR_MOVE = 0.03;
/** EM vs the world: the EEM / ACWI ratio's 6-month change beyond +/- 5 %. */
export const EM_RELATIVE = 0.05;
/** Commodity cycle: DBC 12-month change beyond +/- 10 % (and on the same side of its ma200). */
export const COMMODITY_MOVE = 0.1;
/** Rates: the US 10-year yield moved at least 0.40 percentage points in 3 months. */
export const RATES_MOVE = 0.4;

export const UNKNOWN = "unknown";
export const INVERTED = "inverted";

/**
 * Machine states per regime with their tone. Tone colours the card; it describes, never advises (the
 * dollar has none: its direction is not good or bad per se). Labels live in `regimeStateLabels`.
 */
export const STATE_TONES: Readonly<Record<RegimeKey, Readonly<Record<string, Tone>>>> =
  Object.freeze({
    risk: Object.freeze({ bear: "neg", correction: "warn", bull: "pos", weak: "warn", flat: "" }),
    dollar: Object.freeze({ strong: "", weak: "", flat: "" }),
    em: Object.freeze({ leading: "pos", lagging: "neg", inline: "" }),
    commodities: Object.freeze({ bull: "pos", bear: "neg", flat: "" }),
    rates: Object.freeze({ rising: "warn", falling: "pos", stable: "" }),
  });

/** Every metric label the regimes produce, Polish (the MCP `market` label allows exactly these). */
export const METRIC_LABELS: ReadonlySet<string> = new Set(
  Object.values(metricLabels).map((entry) => entry.pl),
);

const METRIC_LABELS_EN: ReadonlyMap<string, string> = new Map(
  Object.values(metricLabels).map((entry) => [entry.pl, entry.en]),
);

// --------------------------------------------------------------------------- result types

export interface Metric {
  /** Polish label (the identity, see the module doc). */
  readonly label: string;
  readonly value: number;
  /**
   * `pct`: a fraction (0.041 = 4,1 %); `pp` / `bp`: percentage / basis points; `level`: a quote as
   * is (index points, a yield in percent).
   */
  readonly unit: MetricUnit;
  readonly decimals: number;
  /** Appended to a `level` (`" %"` for a yield). */
  readonly suffix: string;
  /** The metric's own series ended more than `STALE_DAYS` days before `asOf`. */
  readonly stale: boolean;
}

export function metric(
  label: string,
  value: number,
  unit: MetricUnit,
  options: { readonly decimals?: number; readonly suffix?: string; readonly stale?: boolean } = {},
): Metric {
  return Object.freeze({
    label,
    value,
    unit,
    decimals: options.decimals ?? 1,
    suffix: options.suffix ?? "",
    stale: options.stale ?? false,
  });
}

export interface StateRun {
  /** First session of the run (after hysteresis). */
  readonly date: IsoDate;
  readonly state: string;
  /** The session the switch became visible (the 5th of the run); the first evaluated session for the first run. */
  readonly confirmed: IsoDate;
  /** The first run: it began before the data, `date` is only the first evaluated session. */
  readonly open: boolean;
}

export interface Regime {
  readonly key: RegimeKey;
  readonly label: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly tone: Tone;
  /** First session of the current state (after hysteresis); null when unknown or open-ended. */
  readonly since: IsoDate | null;
  readonly metrics: readonly Metric[];
  /** Last bar used; null without data. */
  readonly asOf: IsoDate | null;
  readonly stale: boolean;
  readonly missing: boolean;
  readonly meaning: string;
  /** Every reported state run over the stored bars, oldest first (the API shows the last `HISTORY_MAX`). */
  readonly history: readonly StateRun[];
  /** `inverted` for an inverted yield curve (rates). */
  readonly flags: readonly string[];
  /** The current state held since the first evaluated session: its start is before the data. */
  readonly sinceOpen: boolean;
  /** With `sinceOpen`: the first evaluated session (the state held at least since then). */
  readonly sinceMin: IsoDate | null;
  /**
   * Dollar only: USD/PLN over the last 7 calendar days (rate on/before `asOf - 7` -> the newest
   * on/before `asOf`, a fraction); null without both rates or when the newest is stale.
   */
  readonly usdpln1w: number | null;
}

type RegimeDefaults = "history" | "flags" | "sinceOpen" | "sinceMin" | "usdpln1w";

/** A regime with the Python defaults for history, flags, the open-ended fields and the weekly rate. */
export function regime(
  init: Omit<Regime, RegimeDefaults> & Partial<Pick<Regime, RegimeDefaults>>,
): Regime {
  return Object.freeze({
    history: [],
    flags: [],
    sinceOpen: false,
    sinceMin: null,
    usdpln1w: null,
    ...init,
  });
}

// --------------------------------------------------------------------------- labels

/** The Polish label of a regime card (`LABELS[key]`). */
export function regimeLabel(key: RegimeKey): string {
  return regimeLabels[key].pl;
}

/** The regime card's label in `lang`. */
export function displayLabel(key: RegimeKey, lang: UiLang): string {
  return regimeLabels[key][lang];
}

/** The label of a machine state in `lang` (`brak danych` / `no data` for an unknown one). */
export function stateLabel(key: string, state: string, lang: UiLang): string {
  return textsOf(regimeStateLabels, `${key}.${state}`)?.[lang] ?? macroStrings.unknownLabel[lang];
}

/** The regime's state label in `lang` (with the inversion suffix). */
export function displayStateLabel(r: Regime, lang: UiLang): string {
  const text = stateLabel(r.key, r.state, lang);
  return r.flags.includes(INVERTED) ? text + macroStrings.invertedSuffix[lang] : text;
}

function meaningOf(key: string, state: string, lang: UiLang): string {
  const found = textsOf(regimeMeanings, `${key}.${state}`);
  if (found === null) throw new InvariantError(`no meaning for ${key}.${state}`);
  return found[lang];
}

/** The regime's meaning in `lang` (with the inverted-curve note). */
export function displayMeaning(r: Regime, lang: UiLang): string {
  if (lang !== "en") return r.meaning;
  if (r.missing || r.state === UNKNOWN) return macroStrings.unknownMeaning.en;
  const text = meaningOf(r.key, r.state, "en");
  return r.flags.includes(INVERTED) ? `${text} ${macroStrings.invertedMeaning.en}` : text;
}

/** A metric's label in `lang`. */
export function metricLabel(m: Metric, lang: UiLang): string {
  return lang === "en" ? (METRIC_LABELS_EN.get(m.label) ?? m.label) : m.label;
}

/**
 * The text of a metric in `lang`: `+4,1 %`, `-6,2 pp`, `+45 bp`, `98,4`, `4,23 %` (Polish) /
 * `+4.1%`, `-6.2 pp`, `4.23%` (English); a sign on changes, never `-0`.
 */
export function formatMetric(m: Metric, lang: UiLang): string {
  const percent = macroStrings.percent[lang];
  if (m.unit === "pct") return `${formatSigned(m.value * 100, m.decimals, lang)}${percent}`;
  if (m.unit === "pp") return `${formatSigned(m.value, m.decimals, lang)} pp`;
  if (m.unit === "bp") return `${formatSigned(m.value, 0, lang)} bp`;
  const value = roundFloat(m.value, m.decimals);
  const sign = value < 0 ? "-" : "";
  const suffix = m.suffix === " %" ? percent : m.suffix;
  return `${sign}${formatNumber(value, m.decimals, lang)}${suffix}`;
}

// --------------------------------------------------------------------------- series helpers

/** 1 / 0 / -1 for a > b / a == b / a < b, within the relative `TOLERANCE`. */
function cmp(a: number, b: number): number {
  const tol = TOLERANCE * Math.max(1.0, Math.abs(a), Math.abs(b));
  if (a > b + tol) return 1;
  if (a < b - tol) return -1;
  return 0;
}

/** `out[i]` = the maximum of `values[i - n + 1 .. i]` (a monotonic deque; undefined entries before `n - 1`). */
function rollingMax(values: readonly number[], n: number): number[] {
  const out: number[] = new Array(values.length);
  const deque: number[] = [];
  let head = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    while (deque.length > head && (values[deque[deque.length - 1] as number] as number) <= v) {
      deque.pop();
    }
    deque.push(i);
    if ((deque[head] as number) <= i - n) head++;
    out[i] = values[deque[head] as number] as number;
  }
  return out;
}

/** One date-sorted series of closes with O(1) moving means and window peaks. */
class Line {
  readonly dates: readonly IsoDate[];
  readonly closes: readonly number[];
  private readonly sums: readonly number[];
  private peaks: number[] | null = null;

  constructor(dates: readonly IsoDate[], closes: readonly number[]) {
    this.dates = dates;
    this.closes = closes;
    const sums = [0.0];
    let total = 0.0;
    for (const c of closes) {
      total += c;
      sums.push(total);
    }
    this.sums = sums;
  }

  get length(): number {
    return this.closes.length;
  }

  get last(): number {
    return this.closes.length - 1;
  }

  close(i: number): number {
    return this.closes[i] as number;
  }

  ma(i: number, n: number = MA_WINDOW): number {
    return ((this.sums[i + 1] as number) - (this.sums[i + 1 - n] as number)) / n;
  }

  chg(i: number, n: number): number {
    return this.close(i) / this.close(i - n) - 1;
  }

  diff(i: number, n: number): number {
    return this.close(i) - this.close(i - n);
  }

  /** The maximum of the last `n` closes up to `i`; the default window is answered from one O(n) pass. */
  peak(i: number, n: number = PEAK_WINDOW): number {
    if (n === PEAK_WINDOW && i + 1 >= n) {
      this.peaks ??= rollingMax(this.closes, n);
      return this.peaks[i] as number;
    }
    let best = this.close(i + 1 - n);
    for (let j = i + 2 - n; j <= i; j++) best = Math.max(best, this.close(j));
    return best;
  }

  drawdown(i: number): number {
    return this.close(i) / this.peak(i) - 1;
  }
}

/** A close of one series: `[date, value]`. */
export type MacroClose = readonly [IsoDate, number];
/** Closes per series key (`SERIES_KEYS` plus `USDPLN`). */
export type MacroCloses = Readonly<Record<string, readonly MacroClose[] | undefined>>;

function clean(
  points: readonly MacroClose[] | undefined,
  asOf: IsoDate,
  positive: boolean,
): Map<IsoDate, number> {
  const out = new Map<IsoDate, number>();
  for (const [day, value] of points ?? []) {
    if (day > asOf) continue;
    if (!Number.isFinite(value) || (positive && value <= 0)) continue;
    out.set(day, value);
  }
  return out;
}

function sortedDays(days: Iterable<IsoDate>): IsoDate[] {
  return [...days].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function lineOf(points: ReadonlyMap<IsoDate, number>): Line {
  const days = sortedDays(points.keys());
  return new Line(
    days,
    days.map((d) => points.get(d) as number),
  );
}

function joined(
  a: ReadonlyMap<IsoDate, number>,
  b: ReadonlyMap<IsoDate, number>,
): [IsoDate[], number[], number[]] {
  const days = sortedDays([...a.keys()].filter((d) => b.has(d)));
  return [days, days.map((d) => a.get(d) as number), days.map((d) => b.get(d) as number)];
}

function ratioLine(days: readonly IsoDate[], xs: readonly number[], ys: readonly number[]): Line {
  return new Line(
    days,
    xs.map((x, i) => x / (ys[i] as number)),
  );
}

/** Hysteresis over raw states (see the module doc): the reported runs, oldest first. */
export function stateRuns(raw: readonly string[], dates: readonly IsoDate[]): StateRun[] {
  if (raw.length === 0) return [];
  let reported = raw[0] as string;
  const first = dates[0] as IsoDate;
  const runs: StateRun[] = [{ date: first, state: reported, confirmed: first, open: true }];
  let candidate: string | null = null;
  let start = 0;
  let held = 0;
  for (let j = 1; j < raw.length; j++) {
    const r = raw[j] as string;
    if (r === reported) {
      candidate = null;
      held = 0;
      continue;
    }
    if (r === candidate) {
      held += 1;
    } else {
      candidate = r;
      start = j;
      held = 1;
    }
    if (held >= HOLD_SESSIONS) {
      reported = r;
      runs.push({
        date: dates[start] as IsoDate,
        state: r,
        confirmed: dates[j] as IsoDate,
        open: false,
      });
      candidate = null;
      held = 0;
    }
  }
  return runs;
}

function isStale(last: IsoDate | null, asOf: IsoDate): boolean {
  return last === null || daysBetween(last, asOf) > STALE_DAYS;
}

function missingRegime(key: RegimeKey, last: IsoDate | null, asOf: IsoDate): Regime {
  return regime({
    key,
    label: regimeLabel(key),
    state: UNKNOWN,
    stateLabel: macroStrings.unknownLabel.pl,
    tone: "",
    since: null,
    metrics: [],
    asOf: last,
    stale: isStale(last, asOf),
    missing: true,
    meaning: macroStrings.unknownMeaning.pl,
  });
}

function evaluated(
  key: RegimeKey,
  line: Line,
  asOf: IsoDate,
  raw: (i: number) => string,
  metrics: (i: number, stale: boolean) => Metric[],
): Regime {
  const last = line.length > 0 ? (line.dates[line.length - 1] as IsoDate) : null;
  if (line.length < MIN_BARS) return missingRegime(key, last, asOf);
  const first = MIN_BARS - 1;
  const states: string[] = [];
  for (let i = first; i < line.length; i++) states.push(raw(i));
  const runs = stateRuns(states, line.dates.slice(first));
  const current = runs[runs.length - 1] as StateRun;
  const stale = isStale(last, asOf);
  return regime({
    key,
    label: regimeLabel(key),
    state: current.state,
    stateLabel: stateLabel(key, current.state, "pl"),
    tone: STATE_TONES[key][current.state] ?? "",
    since: current.open ? null : current.date,
    metrics: metrics(line.last, stale),
    asOf: last,
    stale,
    missing: false,
    meaning: meaningOf(key, current.state, "pl"),
    history: runs,
    sinceOpen: current.open,
    sinceMin: current.open ? current.date : null,
  });
}

// --------------------------------------------------------------------------- the five regimes

type Points = ReadonlyMap<IsoDate, number>;
const L = metricLabels;

function risk(acwi: Points, spx: Points, asOf: IsoDate): Regime {
  const line = lineOf(acwi);
  const spxLine = lineOf(spx);
  const raw = (i: number): string => {
    const c = line.close(i);
    const ma = line.ma(i);
    const dd = line.drawdown(i);
    if (cmp(dd, BEAR_DRAWDOWN) <= 0) return "bear";
    if (cmp(dd, CORRECTION_DRAWDOWN) <= 0) return "correction";
    if (cmp(c, ma) > 0 && cmp(ma, line.ma(i - SLOPE_LAG)) > 0) return "bull";
    if (cmp(c, ma) < 0) return "weak";
    return "flat";
  };
  const metrics = (i: number, stale: boolean): Metric[] => {
    const out = [
      metric(L.acwiVsMa200.pl, line.close(i) / line.ma(i) - 1, "pct", { stale }),
      metric(L.fromPeak.pl, line.drawdown(i), "pct", { stale }),
    ];
    if (spxLine.length >= PEAK_WINDOW) {
      out.push(
        metric(L.spxFromPeak.pl, spxLine.drawdown(spxLine.last), "pct", {
          stale: isStale(spxLine.dates[spxLine.last] as IsoDate, asOf),
        }),
      );
    }
    return out;
  };
  return evaluated("risk", line, asOf, raw, metrics);
}

/** The index of the last date `<= day` in sorted `dates` (Python `bisect_right(dates, day) - 1`). */
function lastOnOrBefore(dates: readonly IsoDate[], day: IsoDate): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (day < (dates[mid] as IsoDate)) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

/**
 * Close on/before `asOf - 7` -> the newest close on/before `asOf`; null when either is missing, the
 * newest is stale or both are the same day (`week_change`).
 */
function weekChange(line: Line, asOf: IsoDate): number | null {
  if (line.length === 0 || isStale(line.dates[line.last] as IsoDate, asOf)) return null;
  const j = lastOnOrBefore(line.dates, addDays(asOf, -WEEK_DAYS));
  if (j < 0 || (line.dates[j] as IsoDate) >= (line.dates[line.last] as IsoDate)) return null;
  if (line.close(j) <= 0) return null;
  return line.close(line.last) / line.close(j) - 1;
}

function dollar(dxy: Points, usdpln: Points, asOf: IsoDate): Regime {
  const line = lineOf(dxy);
  const pln = lineOf(usdpln);
  const raw = (i: number): string => {
    const c = line.close(i);
    const ma = line.ma(i);
    const c6 = line.chg(i, SIX_MONTHS);
    if (cmp(c, ma) > 0 && cmp(c6, DOLLAR_MOVE) > 0) return "strong";
    if (cmp(c, ma) < 0 && cmp(c6, -DOLLAR_MOVE) < 0) return "weak";
    return "flat";
  };
  const metrics = (i: number, stale: boolean): Metric[] => {
    const out = [
      metric(L.dxy.pl, line.close(i), "level", { stale }),
      metric(L.dxy6m.pl, line.chg(i, SIX_MONTHS), "pct", { stale }),
    ];
    if (pln.length > SIX_MONTHS) {
      out.push(
        metric(L.usdpln6m.pl, pln.chg(pln.last, SIX_MONTHS), "pct", {
          stale: isStale(pln.dates[pln.last] as IsoDate, asOf),
        }),
      );
    }
    return out;
  };
  return regime({
    ...evaluated("dollar", line, asOf, raw, metrics),
    usdpln1w: weekChange(pln, asOf),
  });
}

function em(eem: Points, acwi: Points, asOf: IsoDate): Regime {
  const [days, e, a] = joined(eem, acwi);
  const ratio = ratioLine(days, e, a);
  const eemLine = new Line(days, e);
  const raw = (i: number): string => {
    const r6 = ratio.chg(i, SIX_MONTHS);
    if (cmp(r6, EM_RELATIVE) > 0) return "leading";
    if (cmp(r6, -EM_RELATIVE) < 0) return "lagging";
    return "inline";
  };
  const metrics = (i: number, stale: boolean): Metric[] => [
    metric(L.eemVsAcwi6m.pl, ratio.chg(i, SIX_MONTHS) * 100, "pp", { stale }),
    metric(L.eem6m.pl, eemLine.chg(i, SIX_MONTHS), "pct", { stale }),
  ];
  return evaluated("em", ratio, asOf, raw, metrics);
}

function commodities(dbc: Points, acwi: Points, asOf: IsoDate): Regime {
  const line = lineOf(dbc);
  const [days, d, a] = joined(dbc, acwi);
  const ratio = ratioLine(days, d, a);
  const raw = (i: number): string => {
    const c = line.close(i);
    const ma = line.ma(i);
    const c12 = line.chg(i, TWELVE_MONTHS);
    if (cmp(c, ma) > 0 && cmp(c12, COMMODITY_MOVE) > 0) return "bull";
    if (cmp(c, ma) < 0 && cmp(c12, -COMMODITY_MOVE) < 0) return "bear";
    return "flat";
  };
  const metrics = (i: number, stale: boolean): Metric[] => {
    const out = [metric(L.dbc12m.pl, line.chg(i, TWELVE_MONTHS), "pct", { stale })];
    if (ratio.length > TWELVE_MONTHS) {
      out.push(
        metric(L.dbcVsAcwi12m.pl, ratio.chg(ratio.last, TWELVE_MONTHS) * 100, "pp", {
          stale: isStale(ratio.dates[ratio.last] as IsoDate, asOf),
        }),
      );
    }
    return out;
  };
  return evaluated("commodities", line, asOf, raw, metrics);
}

/**
 * A 13-week bill's discount yield (`^IRX`, percent) as a bond-equivalent yield (percent):
 * `BEY = 365 * d / (360 - 91 * d)` with `d` as a decimal (91-day bill), so it compares with the
 * 10-year Treasury yield (`^TNX`, bond-equivalent).
 */
export function bondEquivalent(discount: number): number {
  const d = discount / 100;
  return (100 * 365 * d) / (360 - 91 * d);
}

function rates(us10y: Points, us3m: Points, asOf: IsoDate): Regime {
  const line = lineOf(us10y);
  const [days, long, short] = joined(us10y, us3m);
  const curve = long.map((x, i) => x - bondEquivalent(short[i] as number));
  const curveStale = days.length === 0 || isStale(days[days.length - 1] as IsoDate, asOf);
  const raw = (i: number): string => {
    const d3 = line.diff(i, THREE_MONTHS);
    if (cmp(d3, RATES_MOVE) >= 0) return "rising";
    if (cmp(d3, -RATES_MOVE) <= 0) return "falling";
    return "stable";
  };
  const metrics = (i: number, stale: boolean): Metric[] => {
    const out = [
      metric(L.us10y.pl, line.close(i), "level", { decimals: 2, suffix: " %", stale }),
      metric(L.us10y3mChange.pl, line.diff(i, THREE_MONTHS) * 100, "bp", { decimals: 0, stale }),
    ];
    if (curve.length > 0) {
      out.push(
        metric(L.curve10y3m.pl, (curve[curve.length - 1] as number) * 100, "bp", {
          decimals: 0,
          stale: curveStale,
        }),
      );
    }
    return out;
  };
  const found = evaluated("rates", line, asOf, raw, metrics);
  if (found.missing || curve.length === 0 || curveStale) return found;
  const flagRuns = stateRuns(
    curve.map((c) => (cmp(c, 0.0) < 0 ? "1" : "0")),
    days,
  );
  if ((flagRuns[flagRuns.length - 1] as StateRun).state !== "1") return found;
  return regime({
    ...found,
    stateLabel: found.stateLabel + macroStrings.invertedSuffix.pl,
    tone: "warn",
    meaning: `${found.meaning} ${macroStrings.invertedMeaning.pl}`,
    flags: [INVERTED],
  });
}

/** The five regimes as of `asOf` from the closes per series key (see the module doc), in `ORDER`. */
export function evaluate(closes: MacroCloses, asOf: IsoDate): readonly Regime[] {
  const get = (key: string, positive = true): Points =>
    clean(Object.hasOwn(closes, key) ? closes[key] : undefined, asOf, positive);
  const acwi = get("acwi");
  return Object.freeze([
    risk(acwi, get("spx"), asOf),
    dollar(get("dxy"), get(USDPLN), asOf),
    em(get("eem"), acwi, asOf),
    commodities(get("dbc"), acwi, asOf),
    rates(get("us10y", false), get("us3m", false), asOf),
  ]);
}
