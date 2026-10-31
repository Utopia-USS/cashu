/**
 * Test-for-test translation of `tests/investments/macro/test_p6_regimes.py`: every state of every
 * regime on synthetic series, thresholds exactly at the boundary, hysteresis (4 sessions do not
 * switch, 5 do; `since`), missing / short data, stale, the yield-curve inversion flag (with its own
 * hysteresis), ratio alignment on mismatched dates, the history limit, the pl-PL metric text and the
 * Polish meaning sentences. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "../../dates.js";
import { pySplit } from "../../text.js";
import { macroStrings, regimeMeanings, regimeStateLabels } from "./macro.strings.js";
import {
  bondEquivalent,
  evaluate,
  formatMetric,
  HISTORY_MAX,
  INVERTED,
  type MacroClose,
  type MacroCloses,
  type Metric,
  metric,
  ORDER,
  type Regime,
  SIX_MONTHS,
  STATE_TONES,
  stateLabel,
  stateRuns,
  TWELVE_MONTHS,
} from "./regimes.js";
import { USDPLN } from "./series.js";
import { regimeDict } from "./service.js";
import { geometric, linear, repeat, seriesOf, weekdaysFrom } from "./testing/fixtures.js";

const days = (n: number): IsoDate[] => weekdaysFrom("2024-01-01", n);
const series = seriesOf;

function one(closes: MacroCloses, key: string, asOf?: IsoDate): Regime {
  const last =
    asOf ??
    Object.values(closes)
      .flatMap((points) => (points ?? []).map(([d]) => d))
      .sort()
      .at(-1);
  if (last === undefined) throw new RangeError("no data and no as_of");
  const found = evaluate(closes, last).find((r) => r.key === key);
  if (found === undefined) throw new RangeError(key);
  return found;
}

/** `{label: text}` in Polish (insertion order = metric order). */
function texts(r: Regime): Record<string, string> {
  return Object.fromEntries(r.metrics.map((m) => [m.label, formatMetric(m, "pl")]));
}

const N = 300; // sessions: 260 for the first evaluated session plus a little history

// --------------------------------------------------------------------------- shape, order, missing and stale data

describe("shape, order, missing and stale data", () => {
  // test_order_and_missing_without_data
  it("order and missing without data", () => {
    const out = evaluate({}, "2026-10-08");
    expect(out.map((r) => r.key)).toEqual([...ORDER]);
    for (const r of out) {
      expect(r.missing && r.state === "unknown" && r.stateLabel === "brak danych").toBe(true);
      expect(r.since === null && r.asOf === null && r.stale && r.metrics.length === 0).toBe(true);
      expect(r.tone).toBe("");
      expect(r.history).toEqual([]);
      expect(r.meaning).toBe(macroStrings.unknownMeaning.pl);
    }
    expect(out.map((r) => r.label)).toEqual([
      "Rynek akcji",
      "Dolar",
      "Rynki wschodzące",
      "Surowce",
      "Obligacje i stopy",
    ]);
  });

  // test_259_bars_are_missing_260_are_enough
  it("259 bars are missing, 260 are enough", () => {
    const short = one({ acwi: series(repeat(100, 259)) }, "risk");
    expect(short.missing && short.state === "unknown" && short.asOf === days(259)[258]).toBe(true);
    expect(short.stale).toBe(false);
    const enough = one({ acwi: series(repeat(100, 260)) }, "risk");
    expect(!enough.missing && enough.state === "flat").toBe(true);
    // the state began before the data: open-ended, never a start date
    expect(enough.since).toBeNull();
    expect(enough.sinceOpen).toBe(true);
    expect(enough.sinceMin).toBe(days(260)[259]);
    expect(enough.history.map((h) => [h.date, h.state, h.open])).toEqual([
      [days(260)[259], "flat", true],
    ]);
  });

  // test_stale_after_five_calendar_days
  it("stale after five calendar days", () => {
    const closes = { acwi: series(repeat(100, N)) };
    const last = days(N)[N - 1] as IsoDate;
    expect(one(closes, "risk", addDays(last, 5)).stale).toBe(false);
    expect(one(closes, "risk", addDays(last, 6)).stale).toBe(true);
  });

  // test_bars_after_as_of_are_ignored
  it("bars after as_of are ignored", () => {
    const values = [...repeat(100, N), ...repeat(50, 10)]; // a crash after as_of
    const dates = days(N + 10);
    const r = one({ acwi: series(values, dates) }, "risk", dates[N - 1]);
    expect(r.state).toBe("flat");
    expect(r.asOf).toBe(dates[N - 1]);
  });

  // test_non_positive_prices_are_dropped_but_yields_may_be_zero
  it("non-positive prices are dropped but yields may be zero", () => {
    const values = repeat(100, N);
    values[100] = 0.0;
    expect(one({ acwi: series(values) }, "risk").history).toHaveLength(1); // no division by zero
    const bills = one({ us10y: series(repeat(1, N)), us3m: series(repeat(0, N)) }, "rates");
    expect(texts(bills)["krzywa 10l-3m"]).toBe("+100 bp");
  });
});

// --------------------------------------------------------------------------- risk (ACWI)

/** 100 for 250 sessions, then `level` (the drawdown holds through the evaluated window). */
function dropTo(level: number): number[] {
  return [...repeat(100, 250), ...repeat(level, N - 250)];
}

const triple = (r: Regime) => [r.state, r.stateLabel, r.tone];

describe("risk (ACWI)", () => {
  // test_risk_bear_at_exactly_minus_20_percent
  it("bear at exactly -20 %", () => {
    const r = one({ acwi: series(dropTo(80)) }, "risk");
    expect(triple(r)).toEqual(["bear", "bessa", "neg"]);
    expect(texts(r)["od szczytu"]).toBe("-20,0 %");
  });

  // test_risk_correction_between_10_and_20_percent
  it("correction between 10 and 20 %", () => {
    expect(one({ acwi: series(dropTo(80.01)) }, "risk").state).toBe("correction");
    const exact = one({ acwi: series(dropTo(90)) }, "risk");
    expect(triple(exact)).toEqual(["correction", "korekta", "warn"]);
    expect(one({ acwi: series(dropTo(90.01)) }, "risk").state).toBe("weak");
  });

  // test_risk_bull_weak_and_flat
  it("bull, weak and flat", () => {
    const bull = one({ acwi: series(linear(N, 100, 0.1)) }, "risk");
    expect(triple(bull)).toEqual(["bull", "hossa", "pos"]);
    const weak = one({ acwi: series(linear(N, 100, -0.01)) }, "risk");
    expect(triple(weak)).toEqual(["weak", "słabość", "warn"]);
    const flat = one({ acwi: series(repeat(100, N)) }, "risk"); // close == ma200: neither above nor below
    expect(triple(flat)).toEqual(["flat", "bez trendu", ""]);
    // above a falling mean: flat
    const values = [...linear(N - 6, 100, -0.01), ...repeat(101, 6)];
    expect(one({ acwi: series(values) }, "risk").state).toBe("flat");
  });

  // test_risk_metrics
  it("metrics", () => {
    const acwi = [...repeat(100, 250), ...repeat(95, N - 250)];
    const spx = [...repeat(5000, 270), ...repeat(4500, N - 270)];
    const r = one({ acwi: series(acwi), spx: series(spx) }, "risk");
    const t = texts(r);
    expect(Object.keys(t)).toEqual(["ACWI wobec 200 sesji", "od szczytu", "S&P 500 od szczytu"]);
    expect(t["od szczytu"]).toBe("-5,0 %");
    expect(t["S&P 500 od szczytu"]).toBe("-10,0 %");
    expect(t["ACWI wobec 200 sesji"]).toBe("-3,8 %"); // 95 / mean(150 x 100, 50 x 95) - 1
    expect(r.metrics.every((m) => m.unit === "pct")).toBe(true);
    // S&P 500 needs a year of sessions for its peak
    const shortSpx = series(spx).slice(-251);
    expect(Object.keys(texts(one({ acwi: series(acwi), spx: shortSpx }, "risk")))).not.toContain(
      "S&P 500 od szczytu",
    );
  });
});

// --------------------------------------------------------------------------- dollar (DXY)

describe("dollar (DXY)", () => {
  // test_dollar_strong_weak_flat_and_no_tone
  it("strong, weak, flat and no tone", () => {
    const strong = one({ dxy: series(geometric(N, 1.0003)) }, "dollar");
    expect(triple(strong)).toEqual(["strong", "umacnia się", ""]);
    const weak = one({ dxy: series(geometric(N, 1 / 1.0003)) }, "dollar");
    expect(triple(weak)).toEqual(["weak", "słabnie", ""]);
    const flat = one({ dxy: series(repeat(100, N)) }, "dollar");
    expect([flat.state, flat.stateLabel]).toEqual(["flat", "bez trendu"]);
  });

  // test_dollar_six_month_change_exactly_3_percent_is_flat
  it("a six-month change of exactly 3 % is flat", () => {
    const exact = 1.03 ** (1 / SIX_MONTHS);
    expect(one({ dxy: series(geometric(N, exact)) }, "dollar").state).toBe("flat");
    expect(one({ dxy: series(geometric(N, 1.0301 ** (1 / 126))) }, "dollar").state).toBe("strong");
    expect(one({ dxy: series(geometric(N, 1 / exact)) }, "dollar").state).toBe("flat");
    expect(one({ dxy: series(geometric(N, 0.9699 ** (1 / 126))) }, "dollar").state).toBe("weak");
  });

  // test_dollar_needs_the_mean_on_the_same_side
  it("needs the mean on the same side", () => {
    // a 6-month rise above 3 % but the close below its 200-session mean: flat
    const values = [...repeat(130, 150), ...repeat(100, 50), ...geometric(N - 200, 1.0005)];
    const r = one({ dxy: series(values) }, "dollar");
    expect(texts(r)["6 mies."]?.startsWith("+")).toBe(true);
    expect(r.state).toBe("flat");
  });

  // test_dollar_metrics_and_usdpln_coverage
  it("metrics and USD/PLN coverage", () => {
    const dates = days(N);
    const dxy = series(geometric(N, 1.0003, 98.44), dates);
    const usd = series(geometric(N, 1.0002, 3.9), dates);
    const t = texts(one({ dxy, [USDPLN]: usd }, "dollar"));
    expect(Object.keys(t)).toEqual(["DXY", "6 mies.", "USD/PLN 6 mies."]);
    expect(t.DXY).toMatch(/^\d+,\d$/);
    expect(t["6 mies."]).toBe("+3,9 %");
    expect(t["USD/PLN 6 mies."]).toBe("+2,6 %");
    expect(one({ dxy, [USDPLN]: usd }, "dollar").metrics.some((m) => m.stale)).toBe(false);
    // not enough NBP rates: no USD/PLN metric; too old: marked stale
    expect(Object.keys(texts(one({ dxy, [USDPLN]: usd.slice(-126) }, "dollar")))).not.toContain(
      "USD/PLN 6 mies.",
    );
    const old = one({ dxy, [USDPLN]: usd.slice(0, -10) }, "dollar");
    expect(old.metrics.map((m) => [m.label, m.stale])).toEqual([
      ["DXY", false],
      ["6 mies.", false],
      ["USD/PLN 6 mies.", true],
    ]);
  });
});

// --------------------------------------------------------------------------- emerging markets (EEM / ACWI)

describe("emerging markets (EEM / ACWI)", () => {
  // test_em_leading_lagging_inline
  it("leading, lagging, inline", () => {
    const acwi = series(geometric(N, 1.0002));
    const lead = one({ acwi, eem: series(geometric(N, 1.0002 * 1.0005, 40)) }, "em");
    expect(triple(lead)).toEqual(["leading", "silniejsze od świata", "pos"]);
    const lag = one({ acwi, eem: series(geometric(N, 1.0002 / 1.0005, 40)) }, "em");
    expect(triple(lag)).toEqual(["lagging", "słabsze od świata", "neg"]);
    const inline = one({ acwi, eem: series(geometric(N, 1.0002, 40)) }, "em");
    expect(triple(inline)).toEqual(["inline", "w linii", ""]);
    const t = texts(lead);
    expect(Object.keys(t)).toEqual(["EEM wobec ACWI 6 mies.", "EEM 6 mies."]);
    expect(t["EEM wobec ACWI 6 mies."]).toBe("+6,5 pp");
    expect(t["EEM 6 mies."]).toBe("+9,2 %");
    expect(lead.metrics[0]?.unit).toBe("pp");
  });

  // test_em_relative_change_exactly_5_percent_is_inline
  it("a relative change of exactly 5 % is inline", () => {
    const acwi = series(repeat(100, N));
    const exact = 1.05 ** (1 / SIX_MONTHS);
    expect(one({ acwi, eem: series(geometric(N, exact, 40)) }, "em").state).toBe("inline");
    const above = 1.0501 ** (1 / SIX_MONTHS);
    expect(one({ acwi, eem: series(geometric(N, above, 40)) }, "em").state).toBe("leading");
    expect(one({ acwi, eem: series(geometric(N, 1 / exact, 40)) }, "em").state).toBe("inline");
  });

  // test_em_ratio_aligns_mismatched_dates
  it("the ratio aligns mismatched dates", () => {
    const dates = days(N + 40);
    const allAcwi = series(repeat(100, N + 40), dates);
    const eemValues = geometric(N + 40, 1.0005, 40);
    // EEM misses every 7th session; ACWI misses every 11th and has a session EEM has not yet
    const eem = series(eemValues, dates)
      .filter((_, i) => i % 7 !== 3)
      .slice(0, -1);
    const acwi = allAcwi.filter((_, i) => i % 11 !== 5);
    const last = dates[dates.length - 1] as IsoDate;
    const r = one({ acwi, eem }, "em", last);
    const acwiDays = new Set(acwi.map(([d]) => d));
    const common = eem.map(([d]) => d).filter((d) => acwiDays.has(d));
    expect(r.asOf).toBe(common[common.length - 1]);
    expect(r.state).toBe("leading");
    // fewer than 260 common sessions: missing although each series alone is long enough
    const sparseEem: MacroClose[] = series(eemValues, dates).filter((_, i) => i % 2 === 0);
    const sparseAcwi = series(repeat(100, N + 40), dates).filter((_, i) => i % 2 === 1);
    expect(one({ acwi: sparseAcwi, eem: sparseEem }, "em", last).missing).toBe(true);
  });
});

// --------------------------------------------------------------------------- commodities (DBC)

describe("commodities (DBC)", () => {
  // test_commodities_bull_bear_flat
  it("bull, bear, flat", () => {
    const acwi = series(repeat(100, N));
    const bull = one({ dbc: series(geometric(N, 1.0005, 20)), acwi }, "commodities");
    expect(triple(bull)).toEqual(["bull", "hossa surowcowa", "pos"]);
    const bear = one({ dbc: series(geometric(N, 1 / 1.0005, 20)), acwi }, "commodities");
    expect(triple(bear)).toEqual(["bear", "bessa surowcowa", "neg"]);
    const flat = one({ dbc: series(repeat(20, N)), acwi }, "commodities");
    expect(triple(flat)).toEqual(["flat", "bez trendu", ""]);
    const t = texts(bull);
    expect(Object.keys(t)).toEqual(["DBC 12 mies.", "wobec ACWI 12 mies."]);
    expect(t["DBC 12 mies."]).toBe("+13,4 %");
    expect(t["wobec ACWI 12 mies."]).toBe("+13,4 pp");
    // without ACWI only the DBC metric
    expect(
      Object.keys(texts(one({ dbc: series(geometric(N, 1.0005, 20)) }, "commodities"))),
    ).toEqual(["DBC 12 mies."]);
  });

  // test_commodities_twelve_month_change_exactly_10_percent_is_flat
  it("a twelve-month change of exactly 10 % is flat", () => {
    const exact = 1.1 ** (1 / TWELVE_MONTHS);
    expect(one({ dbc: series(geometric(N, exact, 20)) }, "commodities").state).toBe("flat");
    const above = 1.1001 ** (1 / TWELVE_MONTHS);
    expect(one({ dbc: series(geometric(N, above, 20)) }, "commodities").state).toBe("bull");
    expect(one({ dbc: series(geometric(N, 1 / exact, 20)) }, "commodities").state).toBe("flat");
  });
});

// --------------------------------------------------------------------------- rates (US 10y, 3m)

describe("rates (US 10y, 3m)", () => {
  // test_rates_rising_at_exactly_40_bp_falling_and_stable
  it("rising at exactly 40 bp, falling and stable", () => {
    const bills = series(repeat(3, N));
    const rising = one({ us10y: series(linear(N, 3.5, 0.4 / 63)), us3m: bills }, "rates");
    expect(triple(rising)).toEqual(["rising", "rentowności rosną", "warn"]);
    expect(texts(rising)["3 mies. zmiana"]).toBe("+40 bp");
    const falling = one({ us10y: series(linear(N, 6.0, -0.4 / 63)), us3m: bills }, "rates");
    expect(triple(falling)).toEqual(["falling", "rentowności spadają", "pos"]);
    const stable = one({ us10y: series(linear(N, 3.5, 0.399 / 63)), us3m: bills }, "rates");
    expect(triple(stable)).toEqual(["stable", "rentowności stabilne", ""]);
    expect(one({ us10y: series(linear(N, 6.0, -0.399 / 63)) }, "rates").state).toBe("stable");
  });

  // test_rates_metrics
  it("metrics", () => {
    const r = one({ us10y: series(repeat(4.231, N)), us3m: series(repeat(4.0, N)) }, "rates");
    expect(r.metrics.map((m) => [m.label, formatMetric(m, "pl"), m.unit])).toEqual([
      ["USA 10 lat", "4,23 %", "level"],
      ["3 mies. zmiana", "0 bp", "bp"],
      ["krzywa 10l-3m", "+13 bp", "bp"], // 4,231 % - 4,097 % (bond-equivalent of 4,0 % discount)
    ]);
    expect(r.flags).toEqual([]);
    expect(r.metrics.some((m) => m.stale)).toBe(false);
    // without the bill yield: no curve metric, never inverted
    const alone = one({ us10y: series(repeat(4.231, N)) }, "rates");
    expect(alone.metrics.map((m) => m.label)).toEqual(["USA 10 lat", "3 mies. zmiana"]);
  });

  // test_inverted_curve_flag_with_its_own_hysteresis
  it("the inverted curve flag has its own hysteresis", () => {
    const dates = days(N);
    const long = series(repeat(4.0, N), dates);
    const bills = (invertedSessions: number) =>
      series([...repeat(3.5, N - invertedSessions), ...repeat(4.2, invertedSessions)], dates);
    const four = one({ us10y: long, us3m: bills(4) }, "rates");
    expect(four.flags).toEqual([]);
    expect(four.stateLabel).toBe("rentowności stabilne");
    expect(four.tone).toBe("");
    const five = one({ us10y: long, us3m: bills(5) }, "rates");
    expect(five.flags).toEqual([INVERTED]);
    expect(five.tone).toBe("warn");
    expect(five.stateLabel).toBe("rentowności stabilne · krzywa odwrócona");
    expect(five.state).toBe("stable"); // the flag never changes the machine state
    expect(five.meaning.endsWith(macroStrings.invertedMeaning.pl)).toBe(true);
    expect(texts(five)["krzywa 10l-3m"]).toBe("-30 bp"); // 4,0 % - 4,304 % (bond-equivalent of 4,2 %)
    // an exactly flat curve is not inverted (3,90625 % discount = 4,0 % bond-equivalent)
    const flat = one({ us10y: long, us3m: series(repeat(3.90625, N), dates) }, "rates");
    expect(flat.flags).toEqual([]);
    expect(texts(flat)["krzywa 10l-3m"]).toBe("0 bp");
  });
});

// --------------------------------------------------------------------------- hysteresis and history

/** US 10y flat at 4.0, then 4.5 from session `at` (raw state rising from there). */
function jump(total: number, at = 280): number[] {
  return [...repeat(4.0, at), ...repeat(4.5, total - at)];
}

describe("hysteresis and history", () => {
  // test_four_sessions_do_not_switch_five_do
  it("four sessions do not switch, five do", () => {
    const four = one({ us10y: series(jump(284)) }, "rates");
    expect(four.state).toBe("stable");
    expect(four.since).toBeNull();
    expect(four.sinceOpen).toBe(true);
    expect(four.sinceMin).toBe(days(284)[259]);
    const five = one({ us10y: series(jump(285)) }, "rates");
    expect(five.state).toBe("rising");
    expect(five.since).toBe(days(285)[280]);
    expect(five.sinceOpen).toBe(false);
    expect(five.sinceMin).toBeNull();
    const d = days(285);
    expect(five.history.map((h) => [h.date, h.state, h.confirmed, h.open])).toEqual([
      [d[259], "stable", d[259], true],
      [d[280], "rising", d[284], false], // visible on the 5th session
    ]);
  });

  // test_a_short_flip_back_never_switches
  it("a short flip back never switches", () => {
    const values = [...repeat(4.0, 280), ...repeat(4.5, 3), ...repeat(4.0, 30)]; // rising for 3 sessions only
    const r = one({ us10y: series(values) }, "rates");
    expect(r.state).toBe("stable");
    expect(r.history).toHaveLength(1);
  });

  // test_history_keeps_the_last_12_runs_newest_last
  it("history keeps the last 12 runs, newest last", () => {
    const values = repeat(4.0, 260);
    let level = 4.0;
    for (let i = 0; i < 15; i++) {
      // 15 alternating 70-session blocks: rising / stable runs
      level += 0.5;
      values.push(...repeat(level, 70));
    }
    const r = one({ us10y: series(values) }, "rates");
    expect(r.history.length).toBeGreaterThan(HISTORY_MAX); // the regime keeps every run
    const shown = regimeDict(r, "pl").history;
    expect(shown).toHaveLength(HISTORY_MAX);
    expect(shown.some((h) => h.open)).toBe(false);
    const dates = shown.map((h) => h.date);
    expect(dates).toEqual([...dates].sort());
    expect(shown[shown.length - 1]?.date).toBe(r.since);
    expect(shown[shown.length - 1]?.state).toBe(r.state);
  });

  // test_runs_helper
  it("the runs helper", () => {
    const d = days(12);
    const raw = ["a", "b", "b", "b", "b", "b", "a", "a", "c", "c", "c", "c"];
    expect(stateRuns(raw, d).map((r) => [r.date, r.state, r.confirmed, r.open])).toEqual([
      [d[0], "a", d[0], true],
      [d[1], "b", d[5], false],
    ]);
    expect(stateRuns([], [])).toEqual([]);
  });
});

// --------------------------------------------------------------------------- text

describe("text", () => {
  // test_metric_text
  it.each<[Metric, string]>([
    [metric("x", 0.0412, "pct"), "+4,1 %"],
    [metric("x", -0.0412, "pct"), "-4,1 %"],
    [metric("x", -0.0004, "pct"), "0,0 %"],
    [metric("x", 0.0, "pct"), "0,0 %"],
    [metric("x", 6.25, "pp"), "+6,2 pp"],
    [metric("x", -0.04, "pp"), "0,0 pp"],
    [metric("x", 45.4, "bp", { decimals: 0 }), "+45 bp"],
    [metric("x", -12.6, "bp", { decimals: 0 }), "-13 bp"],
    [metric("x", -0.4, "bp", { decimals: 0 }), "0 bp"],
    [metric("x", 1234.5, "bp", { decimals: 0 }), "+1 234 bp"],
    [metric("x", 98.44, "level"), "98,4"],
    [metric("x", 5.231, "level", { decimals: 2, suffix: " %" }), "5,23 %"],
    [metric("x", -0.051, "level", { decimals: 2, suffix: " %" }), "-0,05 %"],
  ])("metric text %#", (m, text) => {
    expect(formatMetric(m, "pl")).toBe(text);
  });

  // test_every_state_has_a_label_and_a_factual_meaning
  it("every state has a label and a factual meaning", () => {
    const emDash = String.fromCodePoint(0x2014);
    const forbidden = new RegExp(`wzro[sś]nie|spadnie|będzie|będą|kupuj|sprzedaj|${emDash}`, "u");
    const labels = regimeStateLabels as Record<string, { pl: string }>;
    const meanings = regimeMeanings as Record<string, { pl: string }>;
    for (const key of ORDER) {
      const states = Object.keys(STATE_TONES[key]);
      expect(Object.keys(meanings).filter((id) => id.startsWith(`${key}.`))).toEqual(
        expect.arrayContaining(states.map((s) => `${key}.${s}`)),
      );
      expect(Object.keys(meanings).filter((id) => id.startsWith(`${key}.`))).toHaveLength(
        states.length,
      );
      for (const [state, tone] of Object.entries(STATE_TONES[key])) {
        const label = labels[`${key}.${state}`]?.pl as string;
        const words = pySplit(label).length;
        expect(words >= 1 && words <= 3 && ["pos", "neg", "warn", ""].includes(tone)).toBe(true);
        expect(stateLabel(key, state, "pl")).toBe(label);
        const meaning = meanings[`${key}.${state}`]?.pl as string;
        expect(meaning.endsWith("."), `${key} ${state}`).toBe(true);
        expect(forbidden.test(meaning), `${key} ${state}`).toBe(false);
      }
    }
    expect(forbidden.test(macroStrings.invertedMeaning.pl + macroStrings.unknownMeaning.pl)).toBe(
      false,
    );
    expect(stateLabel("rates", "unknown", "pl")).toBe("brak danych");
  });
});

// --------------------------------------------------------------------------- fix pass

describe("fix pass: stable since, per-metric staleness, bill yield basis", () => {
  // test_since_does_not_move_with_as_of
  it("since does not move with as_of", () => {
    const n = 700;
    const dates = days(n);
    const acwi = series(
      [...repeat(100, 350), ...Array.from({ length: n - 350 }, (_, i) => 100 * 1.002 ** i)],
      dates,
    );
    const closes = { acwi, dxy: series(repeat(100, n), dates) };
    const seen = new Set<IsoDate | null>();
    for (const back of [0, 1, 21]) {
      // today, a day earlier, a month earlier
      const [risk, dollar] = evaluate(closes, dates[n - 1 - back] as IsoDate) as Regime[];
      expect(risk?.state).toBe("bull");
      expect(risk?.sinceOpen).toBe(false);
      seen.add(risk?.since ?? null);
      expect(dollar?.since).toBeNull();
      expect(dollar?.sinceOpen).toBe(true);
      expect(dollar?.sinceMin).toBe(dates[259]);
    }
    expect(seen.size).toBe(1);
    expect(([...seen][0] as IsoDate) > (dates[350] as IsoDate)).toBe(true);
  });

  // test_secondary_metrics_and_the_flag_carry_their_own_staleness
  it("secondary metrics and the flag carry their own staleness", () => {
    const dates = days(N);
    const last = dates[N - 1] as IsoDate;
    const spx = series(repeat(5000, N - 10), dates.slice(0, -10));
    const risk = one({ acwi: series(repeat(100, N), dates), spx }, "risk", last);
    expect(risk.stale).toBe(false);
    expect(risk.metrics.map((m) => [m.label, m.stale])).toEqual([
      ["ACWI wobec 200 sesji", false],
      ["od szczytu", false],
      ["S&P 500 od szczytu", true],
    ]);
    // bills stop updating while inverted: the flag is dropped, the curve metric marked stale
    const rates = one(
      {
        us10y: series(repeat(4.0, N), dates),
        us3m: series(repeat(4.5, N - 10), dates.slice(0, -10)),
      },
      "rates",
      last,
    );
    expect(rates.flags).toEqual([]);
    expect(rates.tone).toBe("");
    expect(rates.stale).toBe(false);
    const lastMetric = rates.metrics[rates.metrics.length - 1];
    expect([lastMetric?.label, lastMetric?.stale]).toEqual(["krzywa 10l-3m", true]);
    // a stale regime marks its own metrics
    const old = one({ acwi: series(repeat(100, N), dates) }, "risk", addDays(last, 9));
    expect(old.stale).toBe(true);
    expect(old.metrics.every((m) => m.stale)).toBe(true);
  });

  // test_bill_discount_yield_to_bond_equivalent
  it("bill discount yield to bond equivalent", () => {
    expect(bondEquivalent(0.0)).toBe(0.0);
    expect(Math.abs(bondEquivalent(4.043) - 4.1415)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(bondEquivalent(3.90625) - 4.0)).toBeLessThanOrEqual(1e-12);
  });

  // test_flat_dollar_meaning_makes_no_pln_claim
  it("the flat dollar meaning makes no PLN claim", () => {
    const meaning = regimeMeanings["dollar.flat"].pl;
    expect(meaning).not.toContain("zł");
    expect(meaning.startsWith("Indeks dolara nie ma wyraźnego trendu")).toBe(true);
  });
});
