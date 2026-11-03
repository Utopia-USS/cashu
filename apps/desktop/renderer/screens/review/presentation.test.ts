import { setLanguageForTests } from "@cashu/i18n";
import { expect, it } from "vitest";
import { presentReviewItem, reviewDisplayDates, reviewDisplayDay } from "./presentation.js";
import { storySnapshot } from "./storyState.js";

it("offers neutral source-equivalent owner choices per group and keeps thesis actions as annotations", () => {
  setLanguageForTests("en");
  const item = storySnapshot().decide.items[0];
  if (!item) throw new Error("synthetic subject missing");
  expect(presentReviewItem(item).actions.map((action) => action.action)).toEqual([
    "sold",
    "held",
    "snooze",
  ]);
  expect(
    presentReviewItem({ ...item, group: "chance" }).actions.map((action) => action.action),
  ).toEqual(["bought", "held", "snooze"]);
  expect(
    presentReviewItem({ ...item, group: "mixed" }).actions.map((action) => action.action),
  ).toEqual(["ack", "snooze"]);
  expect(
    presentReviewItem({ ...item, kind: "thesis" }).actions.map((action) => action.action),
  ).toEqual(["review", "keep"]);
  expect(
    presentReviewItem({
      ...item,
      group: "risk",
      invalidation: "[to confirm] Margin falls. More detail.",
    }).context,
  ).toBe("Thesis fails when: Margin falls.");
});
it("projects server timestamp display days locally while preserving business date-only values", () => {
  const original = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  try {
    expect(reviewDisplayDay("2026-10-31T23:30:00Z")).toBe("2026-11-01");
    expect(reviewDisplayDay("2026-10-31")).toBe("2026-10-31");
    const snapshot = storySnapshot();
    const note = snapshot.events[0];
    if (!note) throw new Error("synthetic note missing");
    const item = snapshot.decide.items[0];
    if (!item || snapshot.calendar.status !== "current")
      throw new Error("synthetic context missing");
    const display = reviewDisplayDates({
      ...snapshot,
      calendar: {
        status: "current",
        value: { ...snapshot.calendar.value, fetched_at: "2026-10-31T23:30:00Z" },
      },
      decide: {
        ...snapshot.decide,
        items: [{ ...item, ladder: { count: 3, since: "2026-10-31T23:30:00Z" } }],
      },
      macroChanges: [{ key: "risk", label: "Risk", from: "Low", to: "High", since: "2026-10-31" }],
      events: [{ ...note, note: { ...note.note, observed_at: "2026-10-31T23:30:00Z" } }],
    });
    expect(display.notes[note.note.id]).toBe("2026-11-01");
    expect(display.calendarFetched).toBe("2026-11-01");
    expect(display.ladders[item.key]).toBe("2026-11-01");
    expect(display.macroChanges.risk).toBe("2026-10-31");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
