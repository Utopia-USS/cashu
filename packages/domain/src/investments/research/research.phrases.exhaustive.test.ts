// The phrase checks against Python (exhaustive tier, see references/testing.md): 1,600 generated texts
// through every verdict, the sentence split and each pattern's matches, in 8 slices. Vectors:
// parity/python/generators/domain/research_vectors.py.
import { describe, it } from "vitest";
import { pyRegex } from "../../pyRegex.js";
import { expectAll, loadVectors, Mismatches } from "../../testing/vectors.js";
import {
  ADVICE_PATTERN,
  ATTRIBUTION_PATTERN,
  adviceProblem,
  attributedTrendForecast,
  claimProblem,
  FORECAST_PATTERN,
  forecastProblem,
  hasQuantitativeEstimate,
  INSTITUTION_PATTERN,
  MARKET_ADVICE_PATTERN,
  marketViewProblem,
  NOT_INSTITUTIONAL_PATTERN,
  PERIOD_PATTERN,
  PRICE_CALL_PATTERN,
  SENTENCE_PATTERN,
  SPAN_PATTERN,
  YEAR_PATTERN,
} from "./patterns.js";

type Row = readonly unknown[];

describe("phrase checks (advice, claims, forecasts, market views, estimates)", () => {
  const { rows } = loadVectors("research-phrases");
  const patterns: Record<string, RegExp> = {
    FORECAST: pyRegex(FORECAST_PATTERN, "g"),
    ADVICE: pyRegex(ADVICE_PATTERN, "g"),
    MARKET_ADVICE: pyRegex(MARKET_ADVICE_PATTERN, "g"),
    PRICE_CALL: pyRegex(PRICE_CALL_PATTERN, "g"),
    INSTITUTION: pyRegex(INSTITUTION_PATTERN, "g"),
    ATTRIBUTION: pyRegex(ATTRIBUTION_PATTERN, "g"),
    NOT_INSTITUTIONAL: pyRegex(NOT_INSTITUTIONAL_PATTERN, "g"),
    YEAR: pyRegex(YEAR_PATTERN, "g"),
    SPAN: pyRegex(SPAN_PATTERN, "g"),
    PERIOD: pyRegex(PERIOD_PATTERN, "g"),
  };
  const sentence = pyRegex(SENTENCE_PATTERN, "g");

  // The 1,600 texts in 8 slices, so no single test holds all of them.
  const SLICES = 8;
  const size = Math.ceil(rows.length / SLICES);

  it.each(Array.from({ length: SLICES }, (_, slice) => slice))(
    "slice %i of the texts gives Python's verdicts, sentence split and pattern matches",
    (slice) => {
      const m = new Mismatches();
      for (const row of rows.slice(slice * size, (slice + 1) * size) as readonly Row[]) {
        const text = row[0] as string;
        const label = JSON.stringify(text).slice(0, 80);
        m.check(`advice ${label}`, adviceProblem(text), row[1]);
        m.check(`claim ${label}`, claimProblem(text), row[2]);
        m.check(`forecast ${label}`, forecastProblem(text), row[3]);
        m.check(`market ${label}`, marketViewProblem(text), row[4]);
        m.check(`attributed ${label}`, attributedTrendForecast(text), row[5]);
        m.check(`quantitative ${label}`, hasQuantitativeEstimate(text), row[6]);
        m.check(`sentences ${label}`, text.split(sentence), row[7]);
        const expected = row[8] as Record<string, string[]>;
        for (const [name, re] of Object.entries(patterns)) {
          m.check(
            `${name} ${label}`,
            [...text.matchAll(re)].map((x) => x[0]),
            expected[name],
          );
        }
      }
      expectAll(m);
    },
  );
});
