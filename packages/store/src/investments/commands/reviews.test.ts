// Review records: mark done / last / list and undo within 15 minutes, a past day, refusals, vault
// isolation. Synthetic data only.
import { describe, expect, it } from "vitest";
import { lastReview, reviewByGid, reviews } from "../queries/reviews.js";
import { MAX_REVIEW_NOTES, markReviewDone, RECORDED_AT, undoReview } from "./reviews.js";
import { otherVault, type Vault, vault } from "./testing/fixtures.js";

const read = (v: Vault) => v.store.read.bind(v.store);
const MINUTE = 60_000;
/** The fixtures' clock: 2026-10-31T12:00Z. */
const TODAY = "2026-10-31";

describe("markReviewDone", () => {
  it("records reviews per module and profile; lastReview is the newest", () => {
    const a = vault();
    const b = otherVault();
    expect(lastReview(read(a), "investments")).toBeUndefined();
    const first = a.value(markReviewDone, {
      module: "investments",
      notes: "  ok  ",
      stats: { open_signals: 2 },
    }).review;
    a.env.advance(1000);
    const second = a.value(markReviewDone, { module: "investments" }).review;
    a.env.advance(1000);
    a.value(markReviewDone, { module: "budget", notes: "b" });
    b.value(markReviewDone, { module: "investments", notes: "other profile" });
    const firstRow = reviewByGid(read(a), first);
    expect([firstRow?.notes, firstRow?.stats]).toEqual(["ok", { open_signals: 2 }]);
    expect(reviewByGid(read(a), second)?.notes).toBeNull();
    expect(firstRow?.doneAt).toBe("2026-10-31 12:00:00.000000");
    expect(lastReview(read(a), "investments")?.gid).toBe(second);
    expect(reviews(read(a)).map((r) => r.module)).toEqual(["budget", "investments", "investments"]);
    expect(reviews(read(a), "investments", 1)).toHaveLength(1);
    expect(reviews(read(b)).map((r) => r.notes)).toEqual(["other profile"]);
    expect(lastReview(read(a), "budget")?.notes).toBe("b");
  });

  it("refuses an unknown module and over-long notes", () => {
    const a = vault();
    expect(a.run(markReviewDone, { module: "nope" })).toEqual({
      ok: false,
      reason: "unknown_module",
    });
    expect(
      a.run(markReviewDone, { module: "investments", notes: "x".repeat(MAX_REVIEW_NOTES + 1) }),
    ).toEqual({ ok: false, reason: "notes_too_long" });
    expect(reviews(read(a))).toEqual([]);
  });
});

describe("undoReview and backdated reviews", () => {
  it("a review just saved can be undone once, only in its own profile", () => {
    const a = vault();
    const b = otherVault();
    const review = a.value(markReviewDone, { module: "investments", notes: "ok" }).review;
    expect(b.run(undoReview, { review })).toEqual({ ok: false, reason: "no_review" }); // other vault
    expect(a.value(undoReview, { review })).toEqual({ review });
    expect(reviews(read(a), "investments")).toEqual([]);
    expect(a.run(undoReview, { review })).toEqual({ ok: false, reason: "no_review" });
  });

  it("the undo expires after 15 minutes", () => {
    const a = vault();
    const review = a.value(markReviewDone, { module: "investments" }).review;
    a.env.advance(16 * MINUTE);
    expect(a.run(undoReview, { review })).toEqual({ ok: false, reason: "undo_expired" });
    expect(reviewByGid(read(a), review)).toBeDefined();
  });

  it("a review can be recorded for a past day", () => {
    const a = vault();
    const past = "2026-10-21";
    const review = a.value(markReviewDone, { module: "investments", doneAt: past }).review;
    const row = reviewByGid(read(a), review);
    expect(row?.doneAt).toBe(`${past} 12:00:00.000000`);
    expect(row?.stats[RECORDED_AT]).toBe("2026-10-31T12:00:00+00:00");
    expect(reviews(read(a), "investments")[0]?.doneAt.startsWith(past)).toBe(true);
    expect(lastReview(read(a), "investments")?.gid).toBe(review);
    expect(a.run(undoReview, { review }).ok).toBe(true); // just saved

    const today = a.value(markReviewDone, { module: "investments", doneAt: TODAY }).review;
    expect(reviewByGid(read(a), today)?.stats).toEqual({}); // today: saved now, as without doneAt

    expect(a.run(markReviewDone, { module: "investments", doneAt: "2026-11-01" })).toEqual({
      ok: false,
      reason: "done_at_in_future",
    });
    expect(a.run(markReviewDone, { module: "investments", doneAt: "05.10.2026" })).toEqual({
      ok: false,
      reason: "invalid_done_at",
    });
  });

  it("the caller's local day decides today and the future", () => {
    const a = vault();
    // a caller east of UTC is already on 2026-11-01: that day is today (saved now), not refused
    const local = a.value(markReviewDone, {
      module: "investments",
      doneAt: "2026-11-01",
      today: "2026-11-01",
    }).review;
    expect(reviewByGid(read(a), local)?.doneAt).toBe("2026-10-31 12:00:00.000000");
    expect(reviewByGid(read(a), local)?.stats).toEqual({});
  });

  it("a backdated review's undo window counts from saving it", () => {
    const a = vault();
    const review = a.value(markReviewDone, { module: "budget", doneAt: "2026-10-01" }).review;
    a.env.advance(14 * MINUTE);
    expect(a.run(undoReview, { review }).ok).toBe(true);
    const late = a.value(markReviewDone, { module: "budget", doneAt: "2026-10-01" }).review;
    a.env.advance(16 * MINUTE);
    expect(a.run(undoReview, { review: late })).toEqual({ ok: false, reason: "undo_expired" });
  });

  it("the module is stored trimmed", () => {
    const a = vault();
    const review = a.value(markReviewDone, { module: " loans " }).review;
    expect(reviewByGid(read(a), review)?.module).toBe("loans");
  });
});
