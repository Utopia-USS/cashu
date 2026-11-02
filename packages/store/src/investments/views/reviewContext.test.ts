import { parseDateTime } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { viewHash } from "../../snapshot.js";
import { openTestStore } from "../../testing/store.js";
import { household } from "../testing/household.js";
import { ulid } from "../testing/kit.js";
import { readReviewContext, readReviewContextWithCalendar } from "./reviewContext.js";
import { makeReviewClock } from "./reviews.js";

describe("native review deck context", () => {
  it("keeps full agenda/card sources and explicit localization without writing a review", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("review.done", ulid(501), {
        module: "investments",
        doneAt: "2026-10-25T23:30:00Z",
        notes: "Synthetic review",
        stats: {
          deck: { agenda: [{ card: "events", note: "Synthetic agenda" }, null, { card: null }] },
        },
      }),
    ]);
    const clock = makeReviewClock({
      now: parseDateTime("2026-10-31T12:00:00Z"),
      today: "2026-10-31",
      timeZone: "Europe/Warsaw",
    });
    const before = viewHash(store);
    const request = { clock, config: h.strategy.config, calendar: null };
    const en = readReviewContext(store.read.bind(store), { ...request, lang: "en" });
    const pl = readReviewContext(store.read.bind(store), { ...request, lang: "pl" });
    expect(en.since).toBe("2026-10-26");
    expect(en.last_review?.agenda).toEqual([
      { card: "events", note: "Synthetic agenda" },
      { card: null, note: null },
    ]);
    expect(Object.keys(en.card_sources)).toHaveLength(7);
    expect(en.review.name).toBe("Weekly review");
    expect(pl.review.name).toBe("Przegląd tygodnia");
    expect(viewHash(store)).toEqual(before);
    store.close();
  });
  it("treats an offline calendar-port failure as stale while preserving the rest of the deck", async () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    let called = 0;
    const value = await readReviewContextWithCalendar(store.read.bind(store), {
      config: h.strategy.config,
      lang: "en",
      clock: makeReviewClock({
        now: parseDateTime("2026-10-31T12:00:00Z"),
        today: "2026-10-31",
        timeZone: "Europe/Warsaw",
      }),
      calendar: async (request) => {
        called++;
        expect(request.days).toBe(14);
        throw new Error("Synthetic offline feed");
      },
    });
    expect(called).toBe(1);
    expect(value.calendar).toEqual({ stale: true, events: [] });
    expect(value.review.cards).toHaveLength(7);
    store.close();
  });
});
