/** Recommendation freshness: what makes a saved plan outdated or maybe outdated, and the reason order. */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { formatInstant, type ScoredNote } from "../research/index.js";
import {
  type FreshnessFacts,
  type FreshnessNote,
  planFreshness,
  planInstant,
} from "./freshness.js";

const at = (value: string) => planInstant(parseDateTime(`${value}T12:00:00Z`));
const PLAN_AT = at("2026-10-01");
const NOW = at("2026-10-06");
let nextId = 0;
const note = (over: Partial<ScoredNote> = {}): FreshnessNote => {
  const id = ++nextId;
  return {
    id: `note:${id}`,
    scored: {
      id,
      kind: "news",
      polarity: "neutral",
      strength: 1,
      thesisRelation: "neutral",
      observedAt: at("2026-10-02"),
      createdAt: at("2026-10-02"),
      expiresAt: at("2026-10-26"),
      dismissedAt: null,
      ...over,
    },
  };
};
const fresh = (over: Partial<FreshnessFacts> = {}, now = NOW) =>
  planFreshness({ plan: "hold", planAt: PLAN_AT, health: "current", ...over }, now);
const codes = (over: Partial<FreshnessFacts> = {}, now = NOW) => {
  const f = fresh(over, now);
  return f === null ? null : [f.state, f.reasons.map((r) => r.code)];
};

describe("planFreshness", () => {
  it("has nothing to say without a saved plan", () => {
    expect(fresh({ plan: null })).toBeNull();
    expect(fresh({ planAt: null })).toBeNull();
    expect(codes()).toEqual(["fresh", []]);
  });

  it("an invalidating note after the plan outdates it and names the newest note", () => {
    const older = note({ thesisRelation: "invalidates", createdAt: at("2026-10-02") });
    const newer = note({ thesisRelation: "invalidates", createdAt: at("2026-10-03") });
    const f = fresh({ notes: [newer, older] });
    expect(f?.state).toBe("outdated");
    expect(f?.reasons).toEqual([
      {
        code: "note_invalidates",
        at: newer.scored.createdAt,
        noteId: newer.id,
        relation: "invalidates",
        count: 2,
      },
    ]);
  });

  it("ignores notes from before the plan, candidate notes and notes dismissed by now", () => {
    expect(
      codes({
        notes: [
          note({ thesisRelation: "invalidates", createdAt: at("2026-09-30") }),
          note({ thesisRelation: "invalidates", kind: "candidate" }),
          note({ thesisRelation: "invalidates", dismissedAt: at("2026-10-04") }),
        ],
      }),
    ).toEqual(["fresh", []]);
  });

  it("a fulfilling note outdates only a buy plan", () => {
    const fulfills = [note({ thesisRelation: "fulfills" })];
    expect(codes({ plan: "buy", notes: fulfills })).toEqual(["outdated", ["fulfilled_buy"]]);
    expect(codes({ plan: "hold", notes: fulfills })).toEqual(["maybe_outdated", ["note_after"]]);
  });

  it("an invalidated thesis outdates every plan but the held-only ones", () => {
    expect(codes({ health: "invalidated" })).toEqual(["outdated", ["thesis_invalidated"]]);
    expect(codes({ plan: "reduce", health: "invalidated" })).toEqual(["fresh", []]);
  });

  it("a strength-only opinion is dated by strength_at and judged like a plan", () => {
    const only = { plan: null, planAt: null, positionStrength: "neutral", strengthAt: PLAN_AT };
    expect(codes(only)).toEqual(["fresh", []]);
    expect(fresh({ ...only, strengthAt: null })).toBeNull();
    expect(codes({ ...only, notes: [note({ thesisRelation: "invalidates" })] })).toEqual([
      "outdated",
      ["note_invalidates"],
    ]);
    expect(codes(only, at("2026-11-01"))).toEqual(["maybe_outdated", ["age"]]);
    // notes from before strength_at do not count
    expect(
      codes({
        ...only,
        notes: [note({ thesisRelation: "invalidates", createdAt: at("2026-09-30") })],
      }),
    ).toEqual(["fresh", []]);
  });

  it("a fulfilling note also outdates a strong strength; an invalidated thesis spares a weak one", () => {
    const fulfills = [note({ thesisRelation: "fulfills" })];
    const strong = { plan: null, planAt: null, positionStrength: "strong", strengthAt: PLAN_AT };
    expect(codes({ ...strong, notes: fulfills })).toEqual(["outdated", ["fulfilled_buy"]]);
    expect(codes({ positionStrength: "strong", strengthAt: PLAN_AT, notes: fulfills })).toEqual([
      "outdated",
      ["fulfilled_buy"],
    ]);
    expect(codes({ ...strong, health: "invalidated" })).toEqual([
      "outdated",
      ["thesis_invalidated"],
    ]);
    expect(
      codes({
        plan: null,
        planAt: null,
        positionStrength: "weak",
        strengthAt: PLAN_AT,
        health: "invalidated",
      }),
    ).toEqual(["fresh", []]);
    expect(codes({ positionStrength: "weak", strengthAt: PLAN_AT, health: "invalidated" })).toEqual(
      ["fresh", []],
    );
  });

  it("strong or thesis-relevant active notes make it maybe outdated, weak ones do not", () => {
    expect(codes({ notes: [note({ strength: 3 })] })).toEqual(["maybe_outdated", ["note_after"]]);
    expect(codes({ notes: [note({ thesisRelation: "supports", strength: 2 })] })).toEqual([
      "maybe_outdated",
      ["note_after"],
    ]);
    expect(codes({ notes: [note({ thesisRelation: "supports", strength: 1 })] })).toEqual([
      "fresh",
      [],
    ]);
    expect(
      codes({ notes: [note({ thesisRelation: "weakens", expiresAt: at("2026-10-05") })] }),
    ).toEqual(["fresh", []]);
  });

  it("a thesis edit, a strategy rule or an alert after the plan, and age over 30 days", () => {
    const f = fresh(
      {
        coreChangedAt: at("2026-10-03"),
        signals: [
          { signalId: "s1", kind: "gain_from_cost", firstSeenAt: at("2026-10-02"), order: 1 },
          { signalId: "s2", kind: "gain_from_cost", firstSeenAt: at("2026-10-04"), order: 2 },
          { signalId: "s0", kind: "price_above", firstSeenAt: at("2026-10-04"), order: 3 },
          { signalId: "old", kind: "loss_from_cost", firstSeenAt: at("2026-09-01"), order: 4 },
        ],
        alerts: [{ alertId: "a1", kind: "price_below", triggeredAt: at("2026-10-05"), order: 1 }],
      },
      at("2026-11-01"),
    );
    expect(f?.state).toBe("maybe_outdated");
    expect(
      f?.reasons.map((r) => [
        r.code,
        r.at === null ? null : formatInstant(r.at),
        r.signalId ?? r.alertId,
      ]),
    ).toEqual([
      ["thesis_changed", "2026-10-03T12:00:00+00:00", undefined],
      ["rule_fired", "2026-10-04T12:00:00+00:00", "s2"],
      ["alert_triggered", "2026-10-05T12:00:00+00:00", "a1"],
      ["age", "2026-10-31T12:00:00+00:00", undefined],
    ]);
    expect(codes({}, at("2026-10-31"))).toEqual(["fresh", []]);
  });
});
