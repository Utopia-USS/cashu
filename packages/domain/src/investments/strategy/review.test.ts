// Port of tests/investments/strategy/test_review_policy.py: strategy.yaml `review:` (frequency,
// weekday, name, deck cards) and the review schedule of the digest (`review_schedule` of
// service/views.py; its twin is `reviewSchedule` here). Python's `tr` picks Polish in tests.

import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import { loadStrategy, REVIEW_CARDS, reviewSchedule, reviewTitle, Weekday } from "./index.js";
import { configOf } from "./testing/load.js";

const BASE = "version: 1\nbase_currency: PLN\n";

describe("review policy", () => {
  it("test_defaults_without_a_review_section", () => {
    const review = configOf(loadStrategy(BASE)).review;
    expect([review.every, review.day, review.cards, reviewTitle(review, "pl")]).toEqual([
      "week",
      null,
      REVIEW_CARDS,
      "Przegląd tygodnia",
    ]);
  });

  it("test_review_section_is_parsed", () => {
    const text = `${BASE}review:\n  every: month\n  day: Saturday\n  cards: [world, decide, calendar]\n`;
    const review = configOf(loadStrategy(text)).review;
    expect(review.every).toBe("month");
    expect(review.day).toBe(Weekday.SATURDAY);
    expect(review.cards).toEqual(["world", "decide", "calendar"]);
    expect(reviewTitle(review, "pl")).toBe("Przegląd miesiąca");
    const named = configOf(loadStrategy(`${BASE}review:\n  name: Niedzielna kawa\n`)).review;
    expect(reviewTitle(named, "pl")).toBe("Niedzielna kawa");
  });

  it.each([
    ["every: daily", 'Unknown review frequency "daily"'],
    ["day: niedziela", 'Unknown weekday "niedziela"'],
    ["cards: [world, wordl]", 'Unknown review card "wordl"'],
    [`name: ${"x".repeat(41)}`, "longer than 40 characters"],
  ])("test_invalid_review_settings_are_errors[%s]", (body, message) => {
    const result = loadStrategy(`${BASE}review:\n  ${body}\n`);
    expect(result.config).toBeNull();
    expect(
      result.issues.some(
        (issue) => issue.message.includes(message) && issue.path.startsWith("review"),
      ),
      JSON.stringify(result.issues),
    ).toBe(true);
  });

  it("test_unknown_review_key_is_a_warning", () => {
    const result = loadStrategy(`${BASE}review:\n  evry: week\n`);
    expect(result.config).not.toBeNull();
    expect(result.issues.some((issue) => issue.path === "review.evry")).toBe(true);
  });
});

const SUN = "2026-11-01";

describe("review schedule", () => {
  it("test_weekly_schedule", () => {
    expect(reviewSchedule("week", 7, SUN, null)).toEqual([true, addDays(SUN, 7)]);
    expect(reviewSchedule("week", 7, SUN, SUN)).toEqual([false, addDays(SUN, 7)]);
    expect(reviewSchedule("week", 7, addDays(SUN, 3), addDays(SUN, -1))[0]).toBe(true);
  });

  it("test_two_week_schedule_skips_the_week_after_a_review", () => {
    expect(reviewSchedule("2weeks", 7, addDays(SUN, 7), SUN)[0]).toBe(false);
    expect(reviewSchedule("2weeks", 7, addDays(SUN, 14), SUN)[0]).toBe(true);
    expect(reviewSchedule("2weeks", 7, SUN, SUN)[1]).toBe(addDays(SUN, 14));
  });

  it("test_monthly_schedule_falls_on_the_first_weekday_of_the_month", () => {
    expect(reviewSchedule("month", 7, "2026-11-10", "2026-11-01")).toEqual([false, "2026-12-06"]);
    expect(reviewSchedule("month", 7, "2026-12-06", "2026-11-01")[0]).toBe(true);
    expect(reviewSchedule("month", 7, "2026-12-05", "2026-11-01")[0]).toBe(false);
  });
});
