/**
 * Test-for-test translation of `tests/investments/macro/test_p7_texts.py`: a summary and an
 * explanation for every regime and state (plain Polish, within the length, no forecast words), the
 * open-ended / unknown since, the dollar card with the portfolio's weekly currency effect, the
 * inverted curve, a missing card, the weekly USD/PLN change and the summary vocabulary check.
 * Synthetic input only.
 */
import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { pyLen } from "../../text.js";
import { macroStrings, regimeIntros, regimeRules } from "./macro.strings.js";
import { evaluate, INVERTED, type MacroClose } from "./regimes.js";
import type { MetricRow } from "./testing/fixtures.js";
import { ALL, textRegime as regime } from "./testing/regimes.js";
import { type CurrencyEffect, explain, SUMMARY_MAX, summary, summaryOk } from "./texts.js";

const EM_DASH = String.fromCodePoint(0x2014);
const FORBIDDEN = ["wzrośnie", "spadnie", "będzie", "prognoz"];
const fx = (contribution: number, foreign: boolean): CurrencyEffect => ({ contribution, foreign });

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("summaries and explanations", () => {
  // test_every_state_has_a_short_plain_summary_and_a_full_explanation
  it.each(ALL)("%s %s has a short plain summary and a full explanation", (key, state) => {
    const r = regime(key, state, { usdpln1w: 0.006 });
    const text = summary(r, "pl", fx(0.006, true));
    expect(text.endsWith(".")).toBe(true);
    expect(text).toContain("od maja 2025");
    expect(pyLen(text), text).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(summaryOk(text), text).toBe(true);
    const full = explain(r, "pl");
    expect(full.startsWith(regimeIntros[key].pl)).toBe(true);
    expect(full).toContain(regimeRules[key].pl);
    expect(full.endsWith(`Teraz: ${r.stateLabel}. ${r.meaning}`)).toBe(true);
    const sentences = count(full, ". ") + 1;
    expect(sentences >= 4 && sentences <= 8).toBe(true);
    for (const word of FORBIDDEN) {
      expect(text.toLowerCase()).not.toContain(word);
      expect(full.toLowerCase()).not.toContain(word);
    }
    expect(text + full).not.toContain(EM_DASH);
  });

  // test_summaries_hand_checked
  it("summaries, hand checked", () => {
    expect(summary(regime("risk", "bull"), "pl")).toBe(
      "Akcje na świecie rosną od maja 2025: są 1,7 % pod rocznym szczytem.",
    );
    const weak = regime("risk", "weak", { metrics: [["od szczytu", -0.062, "pct"]] });
    expect(summary(weak, "pl")).toBe(
      "Akcje na świecie słabną od maja 2025: są pod średnią z 200 sesji i 6,2 % pod rocznym szczytem.",
    );
    const top = regime("risk", "bull", { metrics: [["od szczytu", 0.0, "pct"]] });
    expect(summary(top, "pl")).toBe("Akcje na świecie rosną od maja 2025: są na rocznym szczycie.");
    const bear = regime("risk", "bear", { metrics: [["od szczytu", -0.241, "pct"]] });
    expect(summary(bear, "pl")).toBe(
      "Akcje na świecie w bessie od maja 2025: są 24 % pod rocznym szczytem.",
    );
    expect(summary(regime("commodities", "bull"), "pl")).toBe(
      "Surowce drożeją od maja 2025: +50 % w rok, o 32,1 pp więcej niż akcje na świecie.",
    );
    const lagging = regime("em", "lagging", {
      metrics: [
        ["EEM wobec ACWI 6 mies.", -7.0, "pp"],
        ["EEM 6 mies.", -0.02, "pct"],
      ],
    });
    expect(summary(lagging, "pl")).toBe(
      "Rynki wschodzące radzą sobie gorzej niż świat od maja 2025: w pół roku -2,0 %, o 7,0 pp mniej niż akcje globalne.",
    );
    expect(summary(regime("rates", "rising"), "pl")).toBe(
      "Rentowności obligacji USA rosną od maja 2025: 10-letnie 4,62 %, +0,45 pp w 3 miesiące.",
    );
  });

  // test_dollar_folds_in_the_currency_effect
  it("the dollar folds in the currency effect", () => {
    const strong = regime("dollar", "strong", { usdpln1w: 0.006 });
    expect(summary(strong, "pl", fx(0.006, true))).toBe(
      "Dolar umacnia się od maja 2025: indeks dolara +4,1 % w pół roku. W tym tygodniu USD/PLN +0,6 %, a kursy walut dodały portfelowi 0,6 pp.",
    );
    const flat = regime("dollar", "flat", { usdpln1w: 0.006 }); // 146 characters with the half-year detail
    expect(summary(flat, "pl", fx(0.006, true))).toBe(
      "Dolar bez wyraźnego trendu od maja 2025. W tym tygodniu USD/PLN +0,6 %, a kursy walut dodały portfelowi 0,6 pp.",
    );
    expect(
      summary(flat, "pl", fx(-0.0042, true)).endsWith("a kursy walut odjęły portfelowi 0,4 pp."),
    ).toBe(true);
    expect(
      summary(flat, "pl", fx(0.0001, true)).endsWith(
        "a kursy walut prawie nie zmieniły wyniku portfela.",
      ),
    ).toBe(true);
    // no foreign assets or no portfolio: the market fact only
    expect(summary(flat, "pl", fx(0.0, false)).endsWith("W tym tygodniu USD/PLN +0,6 %.")).toBe(
      true,
    );
    expect(summary(flat, "pl").endsWith("W tym tygodniu USD/PLN +0,6 %.")).toBe(true);
    // no weekly rate: the currency effect alone
    const noRate = regime("dollar", "strong");
    expect(
      summary(noRate, "pl", fx(0.006, true)).endsWith(
        "W tym tygodniu kursy walut dodały portfelowi 0,6 pp.",
      ),
    ).toBe(true);
    expect(summary(noRate, "pl")).toBe(
      "Dolar umacnia się od maja 2025: indeks dolara +4,1 % w pół roku.",
    );
    // too long with the half-year detail: it gives way
    const long = regime("dollar", "flat", {
      since: null,
      sinceOpen: true,
      sinceMin: "2021-10-04",
      usdpln1w: 0.006,
    });
    const text = summary(long, "pl", fx(0.006, true));
    expect(text).not.toContain("w pół roku");
    expect(pyLen(text)).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(text.startsWith("Dolar bez wyraźnego trendu co najmniej od października 2021.")).toBe(
      true,
    );
  });

  // test_inverted_curve_open_since_and_missing
  it("inverted curve, open since and missing", () => {
    const inverted = regime("rates", "stable", { flags: [INVERTED] });
    const text = summary(inverted, "pl");
    expect(text.endsWith(macroStrings.invertedSentence.pl)).toBe(true);
    expect(pyLen(text)).toBeLessThanOrEqual(SUMMARY_MAX);
    const openEnded = regime("risk", "bull", {
      since: null,
      sinceOpen: true,
      sinceMin: "2022-10-03",
    });
    expect(
      summary(openEnded, "pl").startsWith(
        "Akcje na świecie rosną co najmniej od października 2022:",
      ),
    ).toBe(true);
    const unknown = regime("em", "inline", { since: null });
    expect(summary(unknown, "pl").startsWith("Rynki wschodzące idą podobnie jak świat: ")).toBe(
      true,
    );
    const missing = evaluate({}, "2026-10-09");
    expect(new Set(missing.map((r) => summary(r, "pl")))).toEqual(
      new Set([macroStrings.unknownSummary.pl]),
    );
    expect(missing.every((r) => explain(r, "pl").endsWith(macroStrings.unknownMeaning.pl))).toBe(
      true,
    );
    const noMetrics = regime("commodities", "flat", { metrics: [] });
    expect(summary(noMetrics, "pl")).toBe("Surowce bez wyraźnego trendu od maja 2025.");
  });
});

const OPEN_OCTOBER = { since: null, sinceOpen: true, sinceMin: "2025-10-01" } as const;
const LONG_METRICS: Readonly<Record<string, readonly MetricRow[]>> = {
  risk: [["od szczytu", -0.099, "pct"]],
  dollar: [["6 mies.", -0.099, "pct"]],
  em: [
    ["EEM 6 mies.", -0.099, "pct"],
    ["EEM wobec ACWI 6 mies.", -32.15, "pp"],
  ],
  commodities: [
    ["DBC 12 mies.", -0.099, "pct"],
    ["wobec ACWI 12 mies.", -32.15, "pp"],
  ],
  rates: [
    ["USA 10 lat", 14.62, "level"],
    ["3 mies. zmiana", -125, "bp"],
  ],
};

describe("open-ended summaries", () => {
  // test_open_ended_summaries_stay_within_the_length_in_every_state
  const cases = ALL.flatMap(([key, state]) =>
    [[], [INVERTED]].flatMap((flags) =>
      [null, fx(0.0, true), fx(-0.0123, true)].map(
        (currency) => [key, state, flags, currency] as const,
      ),
    ),
  );
  it.each(cases)("%s %s %j %j stays within the length", (key, state, flags, currency) => {
    const r = regime(key, state, {
      metrics: LONG_METRICS[key] ?? [],
      flags,
      usdpln1w: -0.0123,
      ...OPEN_OCTOBER,
    });
    const text = summary(r, "pl", currency);
    expect(pyLen(text), text).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(summaryOk(text), text).toBe(true);
    expect(
      !text.includes("od października 2025") || text.includes("co najmniej od października 2025"),
    ).toBe(true);
  });

  // test_a_long_open_ended_summary_drops_its_since_phrase
  it("a long open-ended summary drops its since phrase", () => {
    // rates + inverted curve: 149 characters with "co najmniej od października 2025"
    const rates = regime("rates", "stable", { flags: [INVERTED], ...OPEN_OCTOBER });
    expect(summary(rates, "pl")).toBe(
      `Rentowności obligacji USA stabilne: 10-letnie 4,62 %, +0,45 pp w 3 miesiące. ${macroStrings.invertedSentence.pl}`,
    );
    // the dollar with the ~0 currency effect: 142 characters with the since phrase
    const dollar = regime("dollar", "flat", { usdpln1w: -0.0123, ...OPEN_OCTOBER });
    expect(summary(dollar, "pl", fx(0.0, true))).toBe(
      "Dolar bez wyraźnego trendu. W tym tygodniu USD/PLN -1,2 %, a kursy walut prawie nie zmieniły wyniku portfela.",
    );
    // short enough: the open-ended phrase stays
    const risk = regime("risk", "weak", { metrics: LONG_METRICS.risk ?? [], ...OPEN_OCTOBER });
    expect(summary(risk, "pl")).toContain("co najmniej od października 2025");
  });
});

describe("weekly USD/PLN change and the vocabulary check", () => {
  // test_weekly_usdpln_change_on_the_dollar_card
  it("weekly USD/PLN change on the dollar card", () => {
    const asOf: IsoDate = "2026-10-09";
    const days = Array.from({ length: 401 }, (_, i) => addDays(asOf, i - 400));
    const weekAgo = addDays(asOf, -7);
    const usdpln: MacroClose[] = days.map((d) => [d, d <= weekAgo ? 4.0 : 4.1]);
    const closes = { dxy: days.map((d) => [d, 100.0] as const), usdpln };
    const dollar = evaluate(closes, asOf)[1];
    expect(roundFloat(dollar?.usdpln1w ?? 0, 6)).toBe(0.025);
    const stale = { dxy: closes.dxy, usdpln: usdpln.filter(([d]) => d < addDays(asOf, -10)) };
    expect(evaluate(stale, asOf)[1]?.usdpln1w).toBeNull();
  });

  // test_vocabulary_check
  it("vocabulary check", () => {
    expect(summaryOk(macroStrings.unknownSummary.pl)).toBe(true);
    expect(summaryOk("1234567")).toBe(false);
    expect(summaryOk("Jan Kowalski rosną.")).toBe(false);
    expect(summaryOk("Dolar słabnie: 12 400 zł.")).toBe(false);
    expect(summaryOk(null)).toBe(false);
  });
});
