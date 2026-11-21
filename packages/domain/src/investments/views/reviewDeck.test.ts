import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import {
  reviewBenchmarkStale,
  reviewCardMembership,
  reviewChangeSince,
  reviewDecideSelection,
  reviewEvents,
  reviewIdeas,
  reviewSectorRows,
  reviewSignalSubjects,
  reviewSubjectGroup,
  reviewWeeklySigma,
} from "./reviewDeck.js";

const point = (date: string, twr: number) => ({
  date,
  twr,
  benchmark: twr / 2,
  value: 100 * (1 + twr),
  flow: 0,
});
describe("source Review deck selection", () => {
  it("uses the exact stale-tail benchmark capability instead of inferring it from unrelated warnings", () => {
    expect(reviewBenchmarkStale({ status: "ok", covers_range_end: false })).toBe(true);
    expect(reviewBenchmarkStale({ status: "ok", covers_range_end: true })).toBe(false);
    expect(reviewBenchmarkStale({ status: "missing", covers_range_end: false })).toBe(false);
    expect(reviewBenchmarkStale({ status: "ok", covers_range_end: null })).toBe(false);
  });
  it("uses last observation before a weekend baseline and source one-point/before-range rules", () => {
    const points = [point("2026-10-23", 0), point("2026-10-26", 0.1), point("2026-10-27", 0.2)];
    expect(reviewChangeSince(points, "2026-10-25").pct).toBeCloseTo(0.2);
    expect(reviewChangeSince(points, "2026-10-26").pct).toBeCloseTo(1.2 / 1.1 - 1);
    expect(reviewChangeSince(points, "2026-10-01").pct).toBeCloseTo(0.2);
    expect(reviewChangeSince(points.slice(0, 1), "2026-10-01")).toEqual({
      pct: null,
      money: null,
      bench: null,
      from: null,
    });
  });
  it("requires forty actual weekly observations for sigma", () => {
    const points = Array.from({ length: 47 }, (_, i) =>
      point(addDays("2026-09-01", i), (i % 3) / 100),
    );
    expect(reviewWeeklySigma(points.slice(0, 46))).toBeNull();
    expect(reviewWeeklySigma(points)).not.toBeNull();
  });
  it("retains top six sectors plus material FX, event score cap and candidate expiry", () => {
    expect(
      reviewSectorRows<{ weight: number | null; contribution: number }>(
        Array.from({ length: 8 }, (_, i) => ({ weight: 0.1, contribution: i / 100 })),
        null,
        { weight: null, contribution: 0.001 },
      ),
    ).toHaveLength(7);
    const notes = Array.from({ length: 8 }, (_, i) => ({
      i,
      kind: "news",
      strength: i,
      relation: "weakens",
      dismissed: false,
      observedAt: `2026-10-${20 + i}`,
    }));
    expect(reviewEvents(notes, (note) => note).map((row) => row.note.i)).toEqual([7, 6, 5, 4]);
    expect(
      reviewIdeas(notes, 1000, (note) => ({
        ...note,
        kind: "candidate",
        accepted: false,
        expired: false,
        expiresAt: note.i === 7 ? "1970-01-01T00:00:00Z" : null,
      })).map((row) => row.i),
    ).toEqual([6, 5, 4]);
    expect(
      reviewCardMembership({
        sectors: false,
        positions: false,
        events: false,
        ideas: false,
        decide: false,
      }).cards,
    ).toEqual(["world", "calendar"]);
  });
  it("collapses canonical string signal ladders and excludes snoozed/decided rows", () => {
    const base = {
      instrument: "native-instrument",
      rule: "r",
      kind: "loss_from_cost",
      polarity: "negative",
      relation: null,
      firstSeen: 1,
      open: true,
      snoozed: false,
      decided: false,
      bucket: null,
    };
    const rows = reviewSignalSubjects([
      { ...base, id: "one", threshold: 0.1 },
      { ...base, id: "two", threshold: 0.2 },
      { ...base, id: "three", threshold: 0.3, snoozed: true },
    ]);
    expect(rows[0]?.live.map((row) => row.id)).toEqual(["two"]);
    expect(rows[0]?.ladder.map((row) => row.id)).toEqual(["one"]);
  });
  it("shares fresh, health, stale and snoozed-Home reason selection across identity types", () => {
    const now = 20 * 86400000;
    const base = {
      instrument: null,
      rule: "rule",
      kind: "k",
      polarity: "negative",
      relation: null,
      firstSeen: now - 18 * 86400000,
      threshold: 0,
      open: true,
      snoozed: false,
      decided: false,
      bucket: null,
    };
    const rows = [
      { ...base, id: "stale" },
      { ...base, id: "health", instrument: "instrument", rule: "health" },
      { ...base, id: "carried", instrument: "carried", rule: "carried", snoozed: true },
    ];
    const options = {
      now,
      since: now - 7 * 86400000,
      health: new Map<string | null, string>([["instrument", "weakens"]]),
    };
    const deck = reviewDecideSelection(rows, options);
    expect(deck.selected.map((row) => row.subject.instrument)).toEqual(["instrument"]);
    expect(deck.stale.map((row) => row.id)).toEqual(["stale"]);
    expect(
      reviewDecideSelection(rows, { ...options, includeSnoozed: true }).selected.map(
        (row) => row.subject.instrument,
      ),
    ).toEqual(["instrument", "carried"]);
    expect(
      reviewSubjectGroup({
        relation: "weakens",
        polarities: ["positive"],
        hasExitPlan: true,
        exitPlanChangedAt: now,
        lastSeen: now - 86400000,
      }),
    ).toBe("risk");
    expect(
      reviewSubjectGroup({
        relation: "weakens",
        polarities: [],
        hasExitPlan: true,
        exitPlanChangedAt: now + 1,
        lastSeen: now - 86400000,
      }),
    ).toBe("plan");
  });
});
