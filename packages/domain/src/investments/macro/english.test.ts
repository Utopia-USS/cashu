/**
 * Test-for-test translation of `tests/investments/macro/test_macro_english.py`: labels, state labels,
 * meanings, metric labels and numbers, summaries within the length, plain sentences and explanations
 * in English; the Polish vocabulary check stays Polish whatever the language. Synthetic input only.
 */
import { describe, expect, it } from "vitest";
import { pyLen } from "../../text.js";
import {
  macroStrings,
  regimeIntros,
  regimeLabels,
  regimeMeanings,
  regimeStateLabels,
} from "./macro.strings.js";
import {
  displayMeaning,
  displayStateLabel,
  formatMetric,
  INVERTED,
  regime,
  UNKNOWN,
} from "./regimes.js";
import { metricDict, regimeDict } from "./service.js";
import { ALL, textRegime } from "./testing/regimes.js";
import { plain, SUMMARY_MAX, summary, summaryOk } from "./texts.js";

const POLISH_LETTERS = new Set("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ");
const textOf = (catalog: object, id: string): string =>
  (catalog as Record<string, { en: string }>)[id]?.en ?? "";

describe("macro texts in English", () => {
  // test_every_state_reads_in_english
  it.each(ALL)("%s %s reads in English", (key, state) => {
    const r = textRegime(key, state, { usdpln1w: 0.006 });
    const card = regimeDict(r, "en", { contribution: 0.006, foreign: true });
    expect(card.label).toBe(regimeLabels[key].en);
    expect(card.state_label).toBe(textOf(regimeStateLabels, `${key}.${state}`));
    expect(card.meaning).toBe(textOf(regimeMeanings, `${key}.${state}`));
    for (const text of [card.summary, card.plain, card.explain]) {
      expect(text.endsWith("."), text).toBe(true);
      expect(
        [...text].some((ch) => POLISH_LETTERS.has(ch)),
        text,
      ).toBe(false);
    }
    expect(pyLen(card.summary)).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(card.summary.includes("since May 2025") || pyLen(card.summary) > 100).toBe(true);
    expect(card.explain.startsWith(regimeIntros[key].en)).toBe(true);
  });

  // test_hand_checked_english
  it("hand checked English", () => {
    expect(summary(textRegime("risk", "bull"), "en")).toBe(
      "Global stocks rising since May 2025: 1.7% below the yearly peak.",
    );
    expect(summary(textRegime("em", "leading"), "en")).toBe(
      "Emerging markets doing better than the world since May 2025: +8.1% in six months, 6.2 pp more than global stocks.",
    );
    expect(summary(textRegime("rates", "rising"), "en")).toBe(
      "US bond yields rising since May 2025: 10-year 4.62%, +0.45 pp in 3 months.",
    );
    const r = textRegime("dollar", "weak");
    expect(r.metrics.map((m) => metricDict(m, "en").label)).toEqual([
      "DXY",
      "6 mo.",
      "USD/PLN 6 mo.",
    ]);
    expect(r.metrics.map((m) => formatMetric(m, "en"))).toEqual(["98.4", "+4.1%", "+2.0%"]);
  });

  // test_inverted_curve_and_missing_in_english
  it("inverted curve and missing in English", () => {
    const inverted = textRegime("rates", "stable", { flags: [INVERTED] });
    const missing = regime({
      ...textRegime("risk", "bull", { metrics: [] }),
      missing: true,
      state: UNKNOWN,
    });
    expect(displayStateLabel(inverted, "en")).toBe("yields stable · inverted curve");
    expect(displayMeaning(inverted, "en").endsWith(macroStrings.invertedMeaning.en)).toBe(true);
    expect(summary(inverted, "en").endsWith(macroStrings.invertedSentence.en)).toBe(true);
    expect(displayStateLabel(missing, "en")).toBe("no data");
    expect(summary(missing, "en")).toBe(macroStrings.unknownSummary.en);
    expect(plain(missing, "en")).toBe(macroStrings.plainUnknown.en);
    expect(displayStateLabel(inverted, "pl")).toBe("rentowności stabilne · krzywa odwrócona");
  });

  // test_the_vocabulary_stays_polish
  it("the vocabulary stays Polish", () => {
    const r = textRegime("risk", "bull");
    const english = summary(r, "en");
    expect(summaryOk(english)).toBe(false);
    expect(summaryOk(summary(r, "pl"))).toBe(true);
  });
});
