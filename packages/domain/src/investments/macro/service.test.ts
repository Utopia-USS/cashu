/**
 * The logic parts of `tests/investments/persistence/test_p6_macro_api.py` (the macro card shape, the
 * empty view, the macro note targets of the segment catalog, the run scope with macro keys and the
 * review digest's regime switches), on closes built in memory as the test seeds them (stored as
 * 4-decimal strings, read back as floats), with a fixed "today". Plus the service helpers the
 * read model joins (brief, note week, currency effect).
 *
 * Not translated here (store / API bound, S21b / S22a): test_regimes_are_cached_per_data_version,
 * test_macro_note_on_the_card_read_marks_and_filter, test_macro_note_rules,
 * test_macro_notes_count_in_the_weekly_segment_budget, test_strength_3_macro_note_signal_uses_the_card_title,
 * test_macro_keys_are_refused_as_instrument_segments, test_digest_survives_a_failing_macro_view.
 */
import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "../../dates.js";
import { formatFloat, roundFloat } from "../../decimal.js";
import type { SegmentAttribution } from "../performance/segmentAttribution.js";
import { utcInstant } from "../research/instant.js";
import {
  isMacroKey,
  isNoteSegment,
  isSegment,
  MACRO_KEYS,
  macroCatalog,
  regimeOf,
  segmentLabel,
} from "../research/segments.js";
import { ResearchInputError, validateScope } from "../research/validation.js";
import { regimeMeanings } from "./macro.strings.js";
import {
  bondEquivalent,
  evaluate,
  type MacroClose,
  type MacroCloses,
  MIN_BARS,
  type Regime,
  type RegimeKey,
  regimeLabel,
} from "./regimes.js";
import {
  currencyEffectOf,
  currentBrief,
  inSameIsoWeek,
  macroChanges,
  newestAsOf,
  regimeDict,
} from "./service.js";
import { repeat, sessionsBetween } from "./testing/fixtures.js";
import { textRegime } from "./testing/regimes.js";

const TODAY: IsoDate = "2026-10-09"; // the endpoint evaluates as of today
const JUMP = 30; // the 10-year yield jumps this many sessions before the last one
const DAYS = sessionsBetween(addDays(TODAY, -800), TODAY);
const day = (i: number): IsoDate => DAYS.at(i) as IsoDate;

/** Values stored as `f"{v:.<digits>f}"` and read back as floats. */
function stored(values: readonly number[], digits = 4): MacroClose[] {
  return values.map((v, i) => [DAYS[i] as IsoDate, Number(formatFloat(v, `.${digits}f`))] as const);
}

/**
 * ACWI rising (bull), DXY flat, EEM = half of ACWI (inline), no DBC (missing), the 10-year yield
 * 4.20 -> 4.70 `JUMP` sessions ago (rising since then), bills at 4.00 (curve positive).
 */
function seedMacro(skip: readonly string[] = ["dbc"]): MacroCloses {
  const n = DAYS.length;
  const shapes: Record<string, number[]> = {
    acwi: Array.from({ length: n }, (_, i) => 100 + 0.05 * i),
    spx: Array.from({ length: n }, (_, i) => 5000 + 2.0 * i),
    dxy: repeat(100, n),
    eem: Array.from({ length: n }, (_, i) => (100 + 0.05 * i) / 2),
    dbc: repeat(20, n),
    us10y: [...repeat(4.2, n - JUMP), ...repeat(4.7, JUMP)],
    us3m: repeat(4.0, n),
  };
  const out: Record<string, MacroClose[]> = {};
  for (const [key, values] of Object.entries(shapes))
    if (!skip.includes(key)) out[key] = stored(values);
  return out;
}

const CLOSES = seedMacro();

// --------------------------------------------------------------------------- catalog

describe("catalog", () => {
  // test_macro_keys_are_note_targets_only
  it("macro keys are note targets only", () => {
    expect(MACRO_KEYS).toEqual([
      "macro_risk",
      "macro_dollar",
      "macro_em",
      "macro_commodities",
      "macro_rates",
    ]);
    for (const key of MACRO_KEYS) {
      expect(isMacroKey(key) && isNoteSegment(key) && !isSegment(key)).toBe(true);
      expect(segmentLabel(key, "pl")).toBe(regimeLabel(regimeOf(key) as RegimeKey));
    }
    expect(regimeOf("gold")).toBeNull();
    expect(isMacroKey("gold")).toBe(false);
    expect(isNoteSegment("gold")).toBe(true);
    expect(macroCatalog("pl").map((r) => r.segment)).toEqual([...MACRO_KEYS]);
    expect(new Set(macroCatalog("pl").map((r) => r.group))).toEqual(new Set(["macro"]));
  });
});

// --------------------------------------------------------------------------- the card view

const CARD_KEYS = [
  "key",
  "label",
  "state",
  "state_label",
  "tone",
  "since",
  "since_open",
  "since_min",
  "as_of",
  "stale",
  "missing",
  "flags",
  "meaning",
  "summary",
  "explain",
  "metrics",
  "history",
  "plain", // P9
];
// the note fields (note, last_note_at, note_this_week, unread, brief) join in the read model (S22a)

describe("the macro card view", () => {
  // test_macro_endpoint_shape
  it("card shape", () => {
    const found = evaluate(CLOSES, TODAY);
    expect(newestAsOf(found)).toBe(day(-1)); // the newest bar, not the request day
    const cards = found.map((r) => regimeDict(r, "pl"));
    expect(cards.map((c) => c.key)).toEqual(["risk", "dollar", "em", "commodities", "rates"]);
    for (const c of cards) expect(Object.keys(c).sort()).toEqual([...CARD_KEYS].sort());
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    const risk = by.risk;
    expect([risk?.label, risk?.state, risk?.state_label, risk?.tone]).toEqual([
      "Rynek akcji",
      "bull",
      "hossa",
      "pos",
    ]);
    expect(risk?.as_of).toBe(day(-1));
    expect(risk?.stale).toBe(false);
    // bull since the first evaluated session: open-ended
    expect(risk?.since).toBeNull();
    expect(risk?.since_open).toBe(true);
    expect(risk?.since_min).toBe(DAYS[MIN_BARS - 1]);
    expect(risk?.metrics.map((m) => m.label)).toEqual([
      "ACWI wobec 200 sesji",
      "od szczytu",
      "S&P 500 od szczytu",
    ]);
    expect(risk?.metrics[1]).toEqual({
      label: "od szczytu",
      value: 0.0,
      unit: "pct",
      text: "0,0 %",
      stale: false,
    });
    expect(by.dollar?.state).toBe("flat");
    expect(by.dollar?.tone).toBe("");
    expect(by.em?.state_label).toBe("podobnie jak świat");
    const commodities = by.commodities;
    expect(commodities?.missing).toBe(true);
    expect(commodities?.state).toBe("unknown");
    expect(commodities?.state_label).toBe("brak danych");
    expect(commodities?.metrics).toEqual([]);
    expect(commodities?.since).toBeNull();
    expect(commodities?.as_of).toBeNull();
    expect(commodities?.since_open).toBe(false);
    expect(commodities?.since_min).toBeNull();
    expect(commodities?.stale).toBe(true);
    expect(commodities?.history).toEqual([]);
    const rates = by.rates;
    expect([rates?.state, rates?.state_label, rates?.tone]).toEqual([
      "rising",
      "rentowności rosną",
      "warn",
    ]);
    expect(rates?.since).toBe(day(-JUMP));
    expect(rates?.flags).toEqual([]);
    expect(rates?.since_open).toBe(false);
    expect(rates?.since_min).toBeNull();
    expect(rates?.history).toEqual([
      {
        date: DAYS[MIN_BARS - 1],
        state: "stable",
        state_label: "rentowności stabilne",
        open: true,
      },
      { date: day(-JUMP), state: "rising", state_label: "rentowności rosną", open: false },
    ]);
    const curve = roundFloat((4.7 - bondEquivalent(4.0)) * 100, 6);
    expect(rates?.metrics).toEqual([
      { label: "USA 10 lat", value: 4.7, unit: "level", text: "4,70 %", stale: false },
      { label: "3 mies. zmiana", value: 50.0, unit: "bp", text: "+50 bp", stale: false },
      { label: "krzywa 10l-3m", value: curve, unit: "bp", text: "+60 bp", stale: false },
    ]);
    expect(rates?.meaning).toBe(regimeMeanings["rates.rising"].pl);
  });

  // test_macro_view_without_any_data
  it("the view without any data", () => {
    const found = evaluate({}, TODAY);
    expect(found).toHaveLength(5);
    expect(found.every((r) => r.missing && r.stale)).toBe(true);
    expect(newestAsOf(found)).toBeNull();
  });
});

// --------------------------------------------------------------------------- run scope

describe("run scope", () => {
  // test_scope_accepts_macro_keys_on_demand
  it("accepts macro keys on demand", () => {
    const scope = validateScope({ segments: ["macro_rates", "gold", "macro_rates"] });
    expect(scope.segments).toEqual(["macro_rates", "gold"]);
    expect([scope.held, scope.watchlist, scope.candidates]).toEqual([false, false, false]);
    expect(() => validateScope({ segments: ["macro_bogus"] })).toThrow(ResearchInputError);
  });
});

// --------------------------------------------------------------------------- review digest

/** The digest's `macro_changes` for the period `start..asOf` (`research_digest` -> `changes`). */
function digest(closes: MacroCloses, start: IsoDate, asOf: IsoDate = TODAY) {
  return macroChanges(evaluate(closes, asOf), start, asOf, "pl");
}

describe("review digest", () => {
  // test_digest_macro_changes
  it("macro changes", () => {
    expect(digest(CLOSES, addDays(TODAY, -90))).toEqual([
      {
        key: "rates",
        label: "Obligacje i stopy",
        from_label: "rentowności stabilne",
        to_label: "rentowności rosną",
        since: day(-JUMP),
      },
    ]);
    expect(digest(CLOSES, addDays(TODAY, -10))).toEqual([]);
    // as of a day before the jump nothing had changed yet
    const before = day(-JUMP - 1);
    expect(digest(CLOSES, addDays(before, -30), before)).toEqual([]);
  });

  // test_changes_skip_a_flip_back_and_unknown_starts
  it("changes skip a flip back and unknown starts", () => {
    const n = DAYS.length;
    // 10 sessions at 4.7: rising from n-80, stable from n-70, the echo of the jump 63 sessions later
    // falling from n-17, stable again from n-7
    const values = [...repeat(4.2, n - 80), ...repeat(4.7, 10), ...repeat(4.2, 70)];
    const closes = { us10y: stored(values, 3) };
    const rates = evaluate(closes, TODAY)[4] as Regime;
    expect(rates.history.slice(-4).map((h) => [h.date, h.state])).toEqual([
      [day(-80), "rising"],
      [day(-70), "stable"],
      [day(-17), "falling"],
      [day(-7), "stable"],
    ]);
    expect(digest(closes, day(-85))).toEqual([]); // stable -> ... -> stable
    expect(digest(closes, day(-12))).toEqual([
      {
        key: "rates",
        label: "Obligacje i stopy",
        from_label: "rentowności spadają",
        to_label: "rentowności stabilne",
        since: day(-7),
      },
    ]);
    // a period starting before the stored window: the state before it is unknown
    expect(digest(closes, day(0))).toEqual([]);
  });

  // test_since_does_not_slide_with_the_request_day
  it("since does not slide with the request day", () => {
    for (const asOf of [day(-1), day(-2), day(-22)]) {
      // today, a day earlier, a month earlier
      const found = evaluate(CLOSES, asOf);
      const risk = found[0] as Regime;
      const rates = found[4] as Regime;
      expect(rates.since).toBe(day(-JUMP));
      expect(rates.sinceOpen).toBe(false);
      expect(risk.since).toBeNull();
      expect(risk.sinceOpen).toBe(true);
      expect(risk.sinceMin).toBe(DAYS[MIN_BARS - 1]);
    }
  });

  // test_a_switch_straddling_two_digest_periods_shows_exactly_once
  it("a switch straddling two digest periods shows exactly once", () => {
    const started = day(-JUMP);
    const confirmed = day(-JUMP + 4);
    // last week's digest ends after the run began but before the switch was visible
    const first = digest(CLOSES, addDays(started, -7), day(-JUMP + 2));
    // this week's digest starts inside the run, before the confirmation
    const second = digest(CLOSES, day(-JUMP + 3), day(-1));
    expect(first).toEqual([]);
    expect(second.map((c) => [c.key, c.since])).toEqual([["rates", started]]);
    expect(day(-JUMP + 3) <= confirmed).toBe(true);
  });
});

// --------------------------------------------------------------------------- read model helpers

describe("read model helpers (macro_view)", () => {
  // `_current_brief`: a brief of the previous state never shows; an open-ended state keeps it
  it("the current brief", () => {
    const rising = textRegime("rates", "rising", { since: "2026-09-01" });
    const old = { observedAt: utcInstant("2026-08-31", 23, 59) };
    const fresh = { observedAt: utcInstant("2026-09-01") };
    expect(currentBrief([fresh, old], rising)).toBe(fresh);
    expect(currentBrief([old], rising)).toBeNull();
    expect(currentBrief([], rising)).toBeNull();
    const open = textRegime("rates", "rising", { since: null, sinceOpen: true });
    expect(currentBrief([old], open)).toBe(old);
  });

  // `_same_week`: the ISO week of `now` (UTC calendar)
  it("a note of this ISO week", () => {
    const now = utcInstant("2026-10-09", 12); // a Friday
    expect(inSameIsoWeek(utcInstant("2026-10-05"), now)).toBe(true); // Monday
    expect(inSameIsoWeek(utcInstant("2026-10-04", 23, 59), now)).toBe(false); // Sunday before
    expect(inSameIsoWeek(null, now)).toBe(false);
  });

  // `currency_effect`: an empty attribution keeps the market text
  it("the currency effect of the weekly attribution", () => {
    const base: SegmentAttribution = {
      start: "2026-10-02",
      end: "2026-10-09",
      segments: [],
      unassigned: null,
      currencyContribution: 0.0,
      currencies: [],
      explained: 0,
      newPositions: 0,
      stale: [],
    };
    expect(currencyEffectOf(base)).toBeNull();
    const row = { segment: "equity_us", weight: 1, contribution: 0.01, ret: 0.01, instruments: [] };
    expect(currencyEffectOf({ ...base, segments: [row], currencyContribution: 0.004 })).toEqual({
      contribution: 0.004,
      foreign: false,
    });
    const usd = { currency: "USD", weight: 0.5, ret: 0.01, contribution: 0.005 };
    expect(
      currencyEffectOf({
        ...base,
        segments: [row],
        currencyContribution: 0.005,
        currencies: [usd],
      }),
    ).toEqual({ contribution: 0.005, foreign: true });
  });
});
