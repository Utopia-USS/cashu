/**
 * Test-for-test translation of `tests/investments/research/test_rs_validation.py`: pure validation of
 * research notes and runs (sources, URL rules, lengths, enums, details whitelist, candidate details,
 * recommendation / prediction phrases, dates, run scope and counts). Synthetic input only. Each `it`
 * names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { days, utcInstant } from "./instant.js";
import { parseMoment } from "./moment.js";
import { adviceProblem } from "./patterns.js";
import { checkUrl } from "./url.js";
import {
  candidateKey,
  noteExpiresAt,
  ResearchInputError,
  sourceJson,
  validateCounts,
  validateNote,
  validateScope,
} from "./validation.js";

const NOW = utcInstant("2026-10-08", 12);
const SOURCE = {
  url: "https://example.com/news/2026/10/07/spolka-x-wyniki",
  publisher: "Example News",
  published_at: "2026-10-07",
  title: "Spolka X po wynikach",
};

function base(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "news",
    polarity: "negative",
    strength: 2,
    title: "Spolka X obniza prognoze sprzedazy",
    summary: "Zarzad obnizyl prognoze sprzedazy na rok 2026; raport kwartalny z 7.10.",
    sources: [{ ...SOURCE }],
    ...changes,
  };
}

function issues(raw: Record<string, unknown>): string[] {
  try {
    validateNote(raw, NOW);
  } catch (error) {
    if (error instanceof ResearchInputError) return error.issues.map(([where]) => where);
    throw error;
  }
  throw new Error("expected ResearchInputError");
}

describe("research validation (test_rs_validation.py)", () => {
  // test_a_valid_note_is_normalized
  it("a valid note is normalized", () => {
    const data = validateNote(base({ theme: "  Handel   detaliczny " }), NOW);
    expect(data.theme).toBe("Handel detaliczny");
    expect(data.thesisRelation).toBe("none");
    expect(data.expiresInDays).toBe(30);
    expect(data.sources.map(sourceJson)[0]?.published_at).toBe("2026-10-07");
    expect(noteExpiresAt(data, NOW)).toBe(NOW + days(30));
  });

  // test_sources_are_required_with_url_publisher_and_date
  it("sources are required with url, publisher and date", () => {
    expect(issues(base({ sources: [] }))).toEqual(["sources"]);
    expect(issues(base({ sources: [{ ...SOURCE, url: null }] }))).toContain("sources[0].url");
    expect(issues(base({ sources: [{ ...SOURCE, publisher: "" }] }))).toContain(
      "sources[0].publisher",
    );
    expect(issues(base({ sources: [{ ...SOURCE, published_at: null }] }))).toContain(
      "sources[0].published_at",
    );
    // future
    expect(issues(base({ sources: [{ ...SOURCE, published_at: "2026-12-01" }] }))).toContain(
      "sources[0].published_at",
    );
    expect(issues(base({ sources: [{ ...SOURCE, amount: 5 }] }))).toContain("sources[0]");
    // listed twice
    expect(issues(base({ sources: [SOURCE, SOURCE] }))).toContain("sources[1].url");
    expect(issues(base({ sources: Array(11).fill(SOURCE) }))).toEqual(["sources"]);
  });

  // test_bad_urls_are_refused (parametrized)
  it.each([
    "ftp://example.com/a",
    "https://localhost/a",
    "http://127.0.0.1/a",
    "https://[fe80::1%25eth0]/x",
    "https://example.com:65536/x",
    "https://user:pw@example.com/a",
    "https://intranet/a",
    "https://archive.ph/abc",
    "https://www.12ft.io/proxy?q=https://example.com",
    "https://example.com/a b",
    `https://${"a".repeat(600)}.com`,
  ])("bad url is refused: %s", (url) => {
    expect(checkUrl(url)).not.toBeNull();
  });

  // test_good_url
  it("good url", () => {
    expect(checkUrl("https://www.example.pl/rynki/artykul,123.html?x=1")).toBeNull();
  });

  // test_lengths_and_enums
  it("lengths and enums", () => {
    expect(issues(base({ title: "x".repeat(121) }))).toContain("title");
    expect(issues(base({ title: "ab" }))).toContain("title");
    expect(validateNote(base({ title: "two\n lines" }), NOW).title).toBe("two lines");
    expect(issues(base({ title: "bell\x07char" }))).toContain("title");
    expect(issues(base({ summary: "z".repeat(1201) }))).toContain("summary");
    expect(issues(base({ kind: "rumour" }))).toContain("kind");
    expect(issues(base({ polarity: "bullish" }))).toContain("polarity");
    expect(issues(base({ strength: 4 }))).toContain("strength");
    expect(issues(base({ strength: true }))).toContain("strength");
    expect(issues(base({ thesis_relation: "kills" }))).toContain("thesis_relation");
    expect(issues(base({ thesis_field: "entry" }))).toContain("thesis_field");
    // relation none
    expect(issues(base({ thesis_field: "exit_plan" }))).toContain("thesis_field");
    expect(issues(base({ theme: "x".repeat(61) }))).toContain("theme");
    expect(issues(base({ expires_in_days: 91 }))).toContain("expires_in_days");
  });

  // test_details_whitelist_refuses_amounts_and_targets
  it("details whitelist refuses amounts and targets", () => {
    expect(issues(base({ details: { price_target: 120 } }))).toEqual(["details"]);
    expect(issues(base({ details: { position_size: 1000 } }))).toEqual(["details"]);
    expect(issues(base({ details: { criteria: [] } }))).toContain("details.criteria");
    // not community
    expect(issues(base({ details: { scale: "large" } }))).toContain("details.scale");
    const data = validateNote(
      base({ kind: "community", details: { scale: "small", context: "watek na forum" } }),
      NOW,
    );
    expect(data.details).toEqual({ scale: "small", context: "watek na forum" });
    const event = validateNote(
      base({ details: { event: "wyniki Q3", event_date: "2026-10-22" } }),
      NOW,
    );
    expect(event.details).toEqual({ event: "wyniki Q3", event_date: "2026-10-22" });
    expect(issues(base({ details: { event: "wyniki Q3" } }))).toContain("details.event_date");
  });

  // test_candidate_needs_identity_entry_type_and_criteria
  it("candidate needs identity, entry type and criteria", () => {
    const candidate = base({
      kind: "candidate",
      polarity: "positive",
      candidate: { symbol_or_isin: "NEWCO.WA", name: "Newco SA" },
      details: {
        entry_type: "sentiment_correction",
        criteria: [
          { text: "C/Z 9,8", met: true, threshold: "max 15" },
          { text: "dywidenda 1,2%", met: false },
        ],
        criteria_version: 3,
      },
    });
    const data = validateNote(candidate, NOW);
    expect(data.candidate && candidateKey(data.candidate)).toBe("NEWCO.WA");
    expect((data.details?.criteria as unknown[] | undefined)?.[1]).toEqual({
      text: "dywidenda 1,2%",
      met: false,
      threshold: null,
    });
    expect(issues({ ...candidate, details: null })).toContain("details");
    expect(issues({ ...candidate, details: { criteria: [{ text: "a b", met: true }] } })).toContain(
      "details.entry_type",
    );
    expect(issues({ ...candidate, thesis_relation: "supports" })).toContain("thesis_relation");
    expect(issues({ ...candidate, candidate: { symbol_or_isin: "a b" } })).toContain(
      "candidate.symbol_or_isin",
    );
    // not a candidate
    expect(issues(base({ candidate: { symbol_or_isin: "NEWCO.WA" } }))).toContain("candidate");
    expect(issues(base({ details: { entry_type: "trend" } }))).toContain("details.entry_type");
  });

  // test_recommendations_ratings_and_predictions_are_refused (parametrized)
  it.each([
    "Analitycy podnosza cene docelowa do 120 zl",
    "Bank X: rekomendacja kupuj dla spolki",
    "Upgrade to buy after earnings",
    "Strong buy rating reiterated",
    "Kurs wzrosnie do 50 zl w tym roku",
    "The stock will reach 300 by spring",
    "Warto kupic przed dywidenda",
    "Price target raised",
  ])("recommendation / rating / prediction is refused: %s", (text) => {
    expect(adviceProblem(text)).toBe(true);
    expect(issues(base({ title: Array.from(text).slice(0, 120).join("") }))).toContain("title");
  });

  // test_plain_facts_pass_the_phrase_check
  it("plain facts pass the phrase check", () => {
    for (const text of [
      "Inwestorzy sprzedaja akcje po wynikach",
      "Kurs spadl o 8% po publikacji raportu",
      "Sprzedaz wzrosla r/r o 12%",
    ]) {
      expect(adviceProblem(text)).toBe(false);
    }
  });

  // test_dates
  it("dates", () => {
    expect(parseMoment("2026-10-03")).toBe(utcInstant("2026-10-03"));
    expect(parseMoment("2026-10-03T08:00:00Z")).toBe(utcInstant("2026-10-03", 8));
    expect(parseMoment("yesterday")).toBeNull();
    expect(issues(base({ observed_at: "2026-11-01" }))).toContain("observed_at");
    // already expired
    expect(issues(base({ observed_at: "2026-08-01" }))).toContain("observed_at");
    const data = validateNote(base({ observed_at: "2026-09-20", expires_in_days: 45 }), NOW);
    expect(noteExpiresAt(data, NOW)).toBe(utcInstant("2026-11-04"));
  });

  // test_scope_and_counts
  it("scope and counts", () => {
    const scope = validateScope({ themes: ["Banki", "banki", "Energia"], scheduled: true });
    expect(scope.themes).toEqual(["Banki", "Energia"]);
    expect(scope.scheduled).toBe(true);
    expect(scope.held).toBe(true);
    expect(validateScope(null).watchlist).toBe(true);
    expect(() => validateScope({ everything: true })).toThrow(ResearchInputError);
    expect(() => validateScope({ held: "yes" })).toThrow(ResearchInputError);
    expect(validateCounts({ sources_checked: 12 })).toEqual({ sources_checked: 12 });
    // the server counts notes
    expect(() => validateCounts({ notes: 5 })).toThrow(ResearchInputError);
    expect(() => validateCounts({ skipped: -1 })).toThrow(ResearchInputError);
  });

  // test_fulfills_names_the_thesis_or_its_exit_plan_p1
  it("fulfills names the thesis or its exit plan (P1)", () => {
    for (const field of ["thesis", "exit_plan", null]) {
      const raw = base({ thesis_relation: "fulfills", polarity: "positive" });
      if (field !== null) raw.thesis_field = field;
      const data = validateNote(raw, NOW);
      expect(data.thesisRelation).toBe("fulfills");
      expect(data.thesisField).toBe(field);
    }
    for (const field of ["invalidation", "size_plan", "entry_type"]) {
      expect(issues(base({ thesis_relation: "fulfills", thesis_field: field }))).toEqual([
        "thesis_field",
      ]);
    }
    // weakens still takes any field
    expect(
      validateNote(base({ thesis_relation: "weakens", thesis_field: "size_plan" }), NOW),
    ).toBeTruthy();
  });
});
