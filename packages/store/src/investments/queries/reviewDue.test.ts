import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { vault } from "../commands/testing/fixtures.js";
import { saveReview, undoSavedReview } from "../desktop-review/commands.js";
import { readReviewDue } from "./reviewDue.js";

const DAY_MS = 86_400_000;
const zone = "Europe/Warsaw";
const session = {
  cards: [{ id: "world", verdict: "flag" }],
  agenda: [{ card: "world", note: null }],
  decisions: [],
  skipped: [],
  minutes: 4,
};

// The test vault's clock starts on Saturday 2026-10-31 12:00 UTC.
function fixture(strategy: boolean) {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  if (strategy) {
    const template = strategyTemplate("passive_etf");
    if (!template) throw new Error("missing passive_etf template");
    v.value(saveStrategyVersion, { yamlText: template.yaml, mdText: template.markdown });
  }
  return { v, read: v.store.read.bind(v.store) };
}

describe("readReviewDue", () => {
  it("is due on Sunday with no review, and not due after a save that Sunday", () => {
    const { v, read } = fixture(true);
    try {
      expect(readReviewDue(read, { today: "2026-11-01", timeZone: zone })).toEqual({
        due: true,
        nextOn: "2026-11-08",
        lastDoneAt: null,
        every: "week",
        last: null,
      });
      v.env.advance(DAY_MS);
      const saved = v.value(saveReview, { notes: null, session });
      const after = readReviewDue(read, { today: "2026-11-01", timeZone: zone });
      expect(after).toEqual({
        due: false,
        nextOn: "2026-11-08",
        lastDoneAt: "2026-11-01T12:00:00+00:00",
        every: "week",
        last: { gid: saved.review, doneAt: "2026-11-01T12:00:00+00:00", agenda: 1 },
      });
      // A week on, the next Sunday is due again.
      expect(readReviewDue(read, { today: "2026-11-08", timeZone: zone })?.due).toBe(true);
      // Undone, the review no longer counts.
      v.value(undoSavedReview, { review: saved.review });
      expect(readReviewDue(read, { today: "2026-11-01", timeZone: zone })?.due).toBe(true);
    } finally {
      v.store.close();
    }
  });

  it("falls back to the default weekly Sunday policy without a stored strategy", () => {
    const { v, read } = fixture(false);
    try {
      expect(readReviewDue(read, { today: "2026-11-04", timeZone: zone })).toMatchObject({
        due: true,
        every: "week",
        last: null,
      });
    } finally {
      v.store.close();
    }
  });

  it("reads the last review's day in the device zone", () => {
    const { v, read } = fixture(true);
    try {
      // Saturday 23:30 UTC is already Sunday in Warsaw: that Sunday's review is done there, not in UTC.
      v.env.advance(11.5 * 3_600_000);
      v.value(saveReview, { notes: null, session });
      expect(readReviewDue(read, { today: "2026-11-01", timeZone: zone })?.due).toBe(false);
      expect(readReviewDue(read, { today: "2026-11-01", timeZone: "UTC" })?.due).toBe(true);
    } finally {
      v.store.close();
    }
  });

  it("is null without the investments module", () => {
    const { v, read } = fixture(true);
    try {
      v.value(setModules, { moduleIds: [] });
      expect(readReviewDue(read, { today: "2026-11-01", timeZone: zone })).toBeNull();
    } finally {
      v.store.close();
    }
  });
});
