import { parseDateTime } from "@cashu/domain";
import { asInstrumentId, research } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { openTestStore } from "../../testing/store.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { HOUSEHOLD_NOW, household } from "../testing/household.js";
import { ulid } from "../testing/kit.js";
import { readAnnotations } from "./annotations.js";
import { readFacts } from "./facts.js";
import { portfolioAt } from "./portfolio.js";

describe("annotation note selection and synced unread", () => {
  it("includes expired invalidating health-window notes, excludes candidates/old notes, and preserves community weight", () => {
    const h = household();
    const invalidating = ulid(10001),
      community = ulid(10002),
      candidate = ulid(10003),
      old = ulid(10004),
      windowNote = ulid(10005);
    const events = [
      ...h.events,
      h.ev.make("note.added", invalidating, {
        instrument: h.first,
        thesisRelation: "invalidates",
        thesisField: "thesis",
        strength: 2,
        observedAt: "2026-10-20T00:00:00Z",
        expiresAt: "2026-10-25T00:00:00Z",
        stamps: { created_at: "2026-10-10T00:00:00Z" },
      }),
      h.ev.make("note.added", windowNote, {
        instrument: h.first,
        thesisRelation: "weakens",
        strength: 1,
        observedAt: "2026-10-20T00:00:00Z",
        expiresAt: "2026-11-20T00:00:00Z",
        stamps: { created_at: "2026-09-01T00:00:00Z" },
      }),
      h.ev.make("note.added", community, {
        instrument: h.first,
        kind: "community",
        strength: 3,
        observedAt: "2026-10-20T00:00:00Z",
        expiresAt: "2026-11-20T00:00:00Z",
        stamps: { created_at: "2026-10-20T00:00:00Z" },
      }),
      h.ev.make("note.added", candidate, {
        instrument: h.first,
        kind: "candidate",
        candidateKey: "synthetic-candidate",
        observedAt: "2026-10-20T00:00:00Z",
        expiresAt: "2026-11-20T00:00:00Z",
        stamps: { created_at: "2026-10-20T00:00:00Z" },
      }),
      h.ev.make("note.added", old, {
        instrument: h.first,
        observedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-02-01T00:00:00Z",
        stamps: { created_at: "2026-01-01T00:00:00Z" },
      }),
    ];
    assertOrderedDelivery(events, (store) => {
      const read = store.read.bind(store);
      const loaded = portfolioAt(read, {
        vault: h.vault,
        asOf: "2026-10-31",
        prices: h.prices,
        strategy: h.strategy,
        lang: "en",
      });
      if (!loaded.ok) throw new Error(loaded.reason);
      const clock = {
        now: parseDateTime(HOUSEHOLD_NOW),
        today: "2026-10-31",
        timeZone: "Europe/Warsaw",
      };
      const { facts, annotations } = readAnnotations(read, {
        portfolio: loaded.value,
        clock,
        lang: "en",
      });
      const subject = facts.subjects.find((row) => row.instrument.id === h.first);
      expect(subject?.notes.map((row) => row.id)).toEqual([windowNote, invalidating, community]);
      const note = subject?.notes.find((row) => row.id === community);
      expect(research.noteWeight(note?.scored.kind ?? "", note?.scored.strength ?? 0)).toBe(1);
      expect(
        annotations
          .get(asInstrumentId(h.first))
          ?.freshness?.reasons.some((reason) => reason.code === "note_invalidates"),
      ).toBe(true);
      return {
        notes: subject?.notes,
        freshness: annotations.get(asInstrumentId(h.first))?.freshness,
      };
    });
  });

  it("note.read is synced state independent of device-local notification history", () => {
    const h = household();
    const note = ulid(10100);
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("note.added", note, {
        instrument: h.first,
        createdBy: "agent",
        observedAt: "2026-10-30T00:00:00Z",
        expiresAt: "2026-11-20T00:00:00Z",
      }),
    ]);
    const read = store.read.bind(store);
    const loaded = portfolioAt(read, {
      vault: h.vault,
      asOf: "2026-10-31",
      prices: h.prices,
      strategy: h.strategy,
      lang: "en",
    });
    if (!loaded.ok) throw new Error(loaded.reason);
    const request = {
      portfolio: loaded.value,
      clock: { now: parseDateTime(HOUSEHOLD_NOW), today: "2026-10-31", timeZone: "Europe/Warsaw" },
    };
    expect(readFacts(read, request).unread.get(asInstrumentId(h.first))).toBe(1);
    store.applyEnvelopes([h.ev.make("note.read", note)]);
    expect(readFacts(read, request).unread.get(asInstrumentId(h.first)) ?? 0).toBe(0);
    store.rebuild();
    expect(readFacts(read, request).unread.get(asInstrumentId(h.first)) ?? 0).toBe(0);
    store.close();
  });
});
