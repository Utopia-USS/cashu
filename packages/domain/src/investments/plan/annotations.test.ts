/** Saved detail gets freshness only; held/watched inputs keep their distinct hint tables. */
import { expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { thesisHealth } from "../research/index.js";
import { instrument } from "../rules/testing/fixtures.js";
import type { AnnotationSubject, ViewClock } from "../views/types.js";
import { annotateSubjects } from "./annotations.js";
import { planInstant } from "./freshness.js";

it("keeps freshness for held, watched and saved while saved hints remain empty in both languages", () => {
  const clock: ViewClock = {
    now: parseDateTime("2026-11-02T12:00:00Z"),
    today: "2026-11-02",
    timeZone: "Europe/Warsaw",
  };
  const health = thesisHealth([], planInstant(clock.now), { hasThesis: false });
  const subjects: AnnotationSubject[] = ["held", "watched", "saved"].map((state) => ({
    instrument: instrument(state),
    held: state === "held",
    hintsWanted: state !== "saved",
    weight: null,
    health,
    hasThesis: false,
    hasExitPlan: false,
    thesisTracked: true,
    plan: "buy",
    planAt: parseDateTime("2026-10-01T12:00:00Z"),
    coreChangedAt: null,
    notes: [],
    allOpenSignals: [],
    hintTriggeredAlerts: [],
    freshnessTriggeredAlerts: [],
  }));
  for (const lang of ["pl", "en"] as const) {
    const out = annotateSubjects(subjects, clock, lang);
    for (const s of subjects) expect(out.get(s.instrument.id)?.freshness?.codes).toEqual(["age"]);
    expect(out.get(subjects[0]!.instrument.id)?.hints.map((h) => h.code)).toEqual([
      "recommendation_maybe_outdated",
      "no_thesis",
    ]);
    expect(out.get(subjects[1]!.instrument.id)?.hints.map((h) => h.code)).toEqual([
      "recommendation_maybe_outdated",
      "plan_without_thesis",
      "no_thesis",
    ]);
    expect(out.get(subjects[2]!.instrument.id)?.hints).toEqual([]);
  }
});
