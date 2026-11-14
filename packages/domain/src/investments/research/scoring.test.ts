/**
 * Test-for-test translation of `tests/investments/research/test_rs_scoring.py`: ISO weeks, weekly
 * sentiment (community capped, candidates ignored, dismissed excluded, empty weeks null), direction,
 * thesis health (7 states, 30-day window, notes before a core thesis edit tagged, never dropped) and
 * theme keys. Synthetic notes only. Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { daysBetween } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { days, type Instant, utcInstant } from "./instant.js";
import {
  Direction,
  direction,
  HEALTH_ORDER,
  Health,
  healthRank,
  isoWeek,
  noteWeight,
  type ScoredNote,
  sentimentWeeks,
  thesisHealth,
  weekStart,
  weekStarts,
} from "./scoring.js";
import { themeKey } from "./themes.js";

/** A Thursday, ISO week 2026-W41. */
const NOW = utcInstant("2026-10-08", 12);

interface NoteOptions {
  readonly daysAgo?: number;
  readonly kind?: string;
  readonly polarity?: string;
  readonly strength?: number;
  readonly relation?: string;
  readonly dismissedDaysAgo?: number | null;
  readonly storedDaysAgo?: number | null;
  readonly ttlDays?: number;
}

function note(i: number, options: NoteOptions = {}): ScoredNote {
  const {
    daysAgo = 1,
    kind = "news",
    polarity = "positive",
    strength = 2,
    relation = "none",
    dismissedDaysAgo = null,
    storedDaysAgo = null,
    ttlDays = 30,
  } = options;
  const observed: Instant = NOW - days(daysAgo);
  const stored: Instant = NOW - days(storedDaysAgo ?? daysAgo);
  return {
    id: i,
    kind,
    polarity,
    strength,
    thesisRelation: relation,
    observedAt: observed,
    createdAt: stored,
    expiresAt: observed + days(ttlDays),
    dismissedAt: dismissedDaysAgo === null ? null : NOW - days(dismissedDaysAgo),
  };
}

describe("research scoring (test_rs_scoring.py)", () => {
  // test_iso_weeks
  it("iso weeks", () => {
    expect(isoWeek("2026-10-05")).toBe("2026-W41");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(weekStart("2026-10-11")).toBe("2026-10-05");
    const starts = weekStarts("2026-10-07");
    expect(starts).toHaveLength(8);
    expect(starts.at(-1)).toBe("2026-10-05");
    expect(starts[0]).toBe("2026-08-17");
    for (let i = 1; i < starts.length; i++) {
      expect(daysBetween(starts[i - 1] as string, starts[i] as string)).toBe(7);
    }
  });

  // test_weekly_score_formula_and_empty_weeks
  it("weekly score formula and empty weeks", () => {
    const notes = [
      note(1, { daysAgo: 0.5, polarity: "positive", strength: 3 }), // this week
      note(2, { daysAgo: 0.2, polarity: "negative", strength: 1 }), // this week
      note(3, { daysAgo: 8, polarity: "negative", strength: 3 }), // last week
    ];
    const values = sentimentWeeks(notes, NOW);
    expect(values).toHaveLength(8);
    expect(values.at(-1)).toBe(roundFloat((3 - 1) / (3 * 2), 4));
    expect(values.at(-2)).toBe(-1.0);
    expect(values.slice(0, -2)).toEqual(Array(6).fill(null)); // no notes = null, not 0
  });

  // test_community_is_capped_at_strength_one
  it("community is capped at strength one", () => {
    expect(noteWeight("community", 3)).toBe(1);
    expect(noteWeight("news", 3)).toBe(3);
    const values = sentimentWeeks(
      [note(1, { kind: "community", polarity: "positive", strength: 3 })],
      NOW,
    );
    expect(values.at(-1)).toBe(roundFloat(1 / 3, 4));
  });

  // test_candidates_and_dismissed_notes_do_not_count_but_expired_do
  it("candidates and dismissed notes do not count but expired do", () => {
    const notes = [
      note(1, { kind: "candidate", polarity: "positive", strength: 3 }),
      note(2, { polarity: "negative", strength: 3, dismissedDaysAgo: 0.1 }),
      note(3, { daysAgo: 50, polarity: "negative", strength: 3, ttlDays: 30 }), // expired, 8 weeks
    ];
    const values = sentimentWeeks(notes, NOW);
    expect(values.at(-1)).toBeNull();
    expect(values[0] === -1.0 || values[1] === -1.0).toBe(true);
  });

  // test_scoring_as_of_an_earlier_moment
  it("scoring as of an earlier moment", () => {
    const then = NOW - days(7);
    const notes = [
      note(1, { daysAgo: 9, polarity: "positive", strength: 3 }),
      note(2, { daysAgo: 1, polarity: "negative", strength: 3 }), // stored after `then`
      note(3, { daysAgo: 9, polarity: "negative", strength: 3, dismissedDaysAgo: 2 }),
    ];
    const valuesThen = sentimentWeeks(notes, then);
    // note 2 did not exist yet; note 3 was not dismissed yet -> (3 - 3) / 6 = 0
    expect(valuesThen.at(-1)).toBe(0.0);
    expect(sentimentWeeks(notes, NOW).at(-2)).toBe(1.0);
  });

  // test_direction_last_four_vs_previous_four
  it("direction: last four vs previous four", () => {
    expect(direction(Array(8).fill(null))).toBe(Direction.STABLE);
    expect(direction([0.5, 0.5, 0.5, 0.5, -0.5, null, -0.5, -0.5])).toBe(Direction.FALLING);
    expect(direction([-0.5, -0.5, null, null, 0.5, 0.5, 0, 0])).toBe(Direction.RISING);
    expect(direction([0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.3])).toBe(Direction.STABLE);
  });

  // test_health_states
  it("health states", () => {
    const sup = note(1, { relation: "supports" });
    const weak = note(2, { relation: "weakens" });
    const inv = note(3, { relation: "invalidates" });
    const neutral = note(4, { relation: "neutral" });
    const thesis = { hasThesis: true };
    expect(thesisHealth([sup, weak, inv], NOW, thesis).state).toBe(Health.INVALIDATED);
    expect(thesisHealth([sup, weak], NOW, thesis).state).toBe(Health.WEAKENED);
    expect(thesisHealth([sup, neutral], NOW, thesis).state).toBe(Health.SUPPORTED);
    expect(thesisHealth([neutral], NOW, thesis).state).toBe(Health.CURRENT);
    expect(thesisHealth([], NOW, thesis).state).toBe(Health.NO_RESEARCH);
    expect(thesisHealth([], NOW, { hasThesis: true, researched: true }).state).toBe(Health.CURRENT);
    const result = thesisHealth([sup, weak], NOW, { hasThesis: false });
    expect(result.state).toBe(Health.NO_THESIS);
    expect(result.counts.weakens).toBe(1);
    const counted = thesisHealth(
      [sup, weak, note(5, { kind: "community", relation: "weakens" })],
      NOW,
      thesis,
    );
    expect(counted.counts).toEqual({
      supports: 1,
      weakens: 2,
      invalidates: 0,
      fulfills: 0,
      neutral: 0,
      community: 1,
    });
    expect(counted.relation).toBe("weakens");
    expect(new Set(counted.noteIds)).toEqual(new Set([1, 2, 5]));
  });

  // test_health_window_dismissal_expiry
  it("health window, dismissal, expiry", () => {
    const old = note(1, { daysAgo: 31, relation: "invalidates", ttlDays: 60 }); // outside 30 days
    const dismissed = note(2, { relation: "invalidates", dismissedDaysAgo: 0.5 });
    const expired = note(3, { daysAgo: 10, relation: "invalidates", ttlDays: 5 });
    expect(thesisHealth([old, dismissed, expired], NOW, { hasThesis: true }).state).toBe(
      Health.NO_RESEARCH,
    );
  });

  // test_a_thesis_edit_keeps_the_notes_and_only_tags_them
  it("a thesis edit keeps the notes and only tags them (P2)", () => {
    const beforeEdit = note(4, { daysAgo: 3, relation: "weakens" });
    const edited = NOW - days(1);
    const result = thesisHealth([beforeEdit], NOW, { hasThesis: true, thesisChangedAt: edited });
    expect(result.state).toBe(Health.WEAKENED);
    expect(result.counts.weakens).toBe(1);
    expect(result.noteIds).toEqual([4]);
    expect(result.predatesThesis).toBe(true);
    const untouched = thesisHealth([beforeEdit], NOW, { hasThesis: true });
    expect(untouched.state).toBe(Health.WEAKENED);
    expect(untouched.predatesThesis).toBe(false);
  });

  // test_a_new_note_after_the_edit_wins_by_precedence_and_untags
  it("a new note after the edit wins by precedence and untags", () => {
    const edited = NOW - days(2);
    const options = { hasThesis: true, thesisChangedAt: edited };
    const oldSupport = note(1, { daysAgo: 5, relation: "supports" });
    const newWeakens = note(2, { daysAgo: 1, relation: "weakens" });
    let result = thesisHealth([oldSupport, newWeakens], NOW, options);
    expect(result.state).toBe(Health.WEAKENED);
    expect(result.predatesThesis).toBe(false);
    // a new supporting note next to an old invalidating one: invalidated still wins, tagged
    const oldInvalidates = note(3, { daysAgo: 5, relation: "invalidates" });
    const newSupports = note(4, { daysAgo: 1, relation: "supports" });
    result = thesisHealth([oldInvalidates, newSupports], NOW, options);
    expect(result.state).toBe(Health.INVALIDATED);
    expect(result.predatesThesis).toBe(true);
    // one deciding note after the edit is enough to untag
    const newerInvalidates = note(5, { daysAgo: 0.5, relation: "invalidates" });
    result = thesisHealth([oldInvalidates, newerInvalidates], NOW, options);
    expect(result.state).toBe(Health.INVALIDATED);
    expect(result.predatesThesis).toBe(false);
  });

  // test_states_without_deciding_notes_are_never_tagged
  it("states without deciding notes are never tagged", () => {
    const edited = NOW - days(1);
    const neutral = note(1, { daysAgo: 3, relation: "neutral" });
    expect(thesisHealth([neutral], NOW, { hasThesis: true, thesisChangedAt: edited })).toEqual(
      thesisHealth([neutral], NOW, { hasThesis: true }),
    );
    let result = thesisHealth([neutral], NOW, { hasThesis: true, thesisChangedAt: edited });
    expect(result.state).toBe(Health.CURRENT);
    expect(result.predatesThesis).toBe(false);
    result = thesisHealth([], NOW, { hasThesis: true, thesisChangedAt: edited });
    expect(result.state).toBe(Health.NO_RESEARCH);
    expect(result.predatesThesis).toBe(false);
    result = thesisHealth([note(2, { relation: "weakens" })], NOW, { hasThesis: false });
    expect(result.state).toBe(Health.NO_THESIS);
    expect(result.predatesThesis).toBe(false);
  });

  // test_health_order_and_rank
  it("health order and rank", () => {
    expect(HEALTH_ORDER).toEqual([
      Health.INVALIDATED,
      Health.WEAKENED,
      Health.FULFILLED,
      Health.NO_RESEARCH,
      Health.NO_THESIS,
      Health.SUPPORTED,
      Health.CURRENT,
    ]);
    expect(healthRank("invalidated")).toBeLessThan(healthRank("weakened"));
    expect(healthRank("weakened")).toBeLessThan(healthRank("current"));
    expect(healthRank("weakened")).toBeLessThan(healthRank("fulfilled"));
    expect(healthRank("fulfilled")).toBeLessThan(healthRank("no_research"));
    expect(healthRank("bogus")).toBe(7);
  });

  // test_theme_keys_group_case_and_accents
  it("theme keys group case and accents", () => {
    expect(themeKey("Półprzewodniki")).toBe(themeKey("  polprzewodniki "));
    expect(themeKey("Stopy procentowe (NBP)")).toBe("stopy-procentowe-nbp");
    expect(themeKey("!!!")).toBe("theme");
  });

  // test_fulfilled_health_precedence_p1
  it("fulfilled health precedence (P1)", () => {
    const sup = note(1, { relation: "supports" });
    const ful = note(2, { relation: "fulfills" });
    const weak = note(3, { relation: "weakens" });
    const inv = note(4, { relation: "invalidates" });
    const fulfilled = thesisHealth([sup, ful], NOW, { hasThesis: true });
    expect(fulfilled.state).toBe(Health.FULFILLED);
    expect(fulfilled.relation).toBe("fulfills");
    expect(fulfilled.counts.fulfills).toBe(1);
    expect(new Set(fulfilled.noteIds)).toEqual(new Set([1, 2]));
    expect(thesisHealth([ful, weak], NOW, { hasThesis: true }).state).toBe(Health.WEAKENED);
    expect(thesisHealth([ful, inv], NOW, { hasThesis: true }).state).toBe(Health.INVALIDATED);
    expect(thesisHealth([sup], NOW, { hasThesis: true }).state).toBe(Health.SUPPORTED);
    expect(thesisHealth([ful], NOW, { hasThesis: false }).state).toBe(Health.NO_THESIS);
    expect(Health.FULFILLED).toBe("fulfilled");
  });
});
