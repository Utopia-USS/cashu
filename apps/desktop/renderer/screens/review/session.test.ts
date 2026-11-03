import { expect, it } from "vitest";
import { useReviewMemory } from "./memory.js";
import {
  advanceSession,
  backSession,
  type ReviewSession,
  sessionAgenda,
  sessionCard,
  startSession,
} from "./session.js";
import { storySnapshot } from "./storyState.js";

it("back removes a verdict while retaining trimmed note agenda and frozen session membership", () => {
  const snapshot = storySnapshot();
  const first = { ...startSession(snapshot), notes: { world: "  Review this source  " } };
  const second = advanceSession(first, "flag");
  expect(sessionCard(second)).toBe("sectors");
  const back = backSession(second);
  expect(back.verdicts.world).toBeUndefined();
  expect(sessionAgenda(back)).toEqual([{ card: "world", note: "Review this source" }]);
  const changedLive = { ...snapshot, cards: ["calendar" as const], ideas: [] };
  expect(changedLive.cards).not.toEqual(back.snapshot.cards);
  expect(back.snapshot.ideas).toHaveLength(1);
});
it("keeps flagged OR noted agenda and stops advancement at summary", () => {
  const snapshot = storySnapshot();
  let session: ReviewSession = { ...startSession(snapshot), notes: { world: "  " } };
  for (const card of snapshot.cards)
    session = advanceSession(session, card === "sectors" ? "flag" : "keep");
  expect(sessionCard(session)).toBe("summary");
  expect(advanceSession(session, "flag")).toBe(session);
  expect(sessionAgenda(session)).toEqual([{ card: "sectors", note: null }]);
});
it("clears every window-local draft and saved session on privacy or vault lifetime reset", () => {
  const session = startSession(storySnapshot());
  useReviewMemory.setState({
    vault: "synthetic",
    draft: { closing: "Private draft", startedAt: 1000 },
    restored: { closing: "Private restored", session },
    saved: {
      review: "synthetic",
      closing: "Private saved",
      session,
      savedAt: "2026-10-31T12:00:00Z",
    },
  });
  useReviewMemory.getState().clear();
  expect(useReviewMemory.getState()).toMatchObject({
    vault: null,
    draft: null,
    restored: null,
    saved: null,
  });
});
