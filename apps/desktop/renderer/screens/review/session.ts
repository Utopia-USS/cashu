import type { views } from "@cashu/domain/investments";
import type { ReadyReview } from "@cashu/store/investments/review-screen";
export type Card = views.ReviewCardId | "summary";
export interface ReviewSession {
  readonly snapshot: ReadyReview;
  readonly index: number;
  readonly verdicts: Partial<Record<views.ReviewCardId, "keep" | "flag">>;
  readonly notes: Partial<Record<views.ReviewCardId, string>>;
  readonly choices: Readonly<Record<string, string>>;
}
export function startSession(snapshot: ReadyReview): ReviewSession {
  return { snapshot, index: 0, verdicts: {}, notes: {}, choices: {} };
}
export function sessionCard(session: ReviewSession): Card {
  return session.snapshot.cards[session.index] ?? "summary";
}
export function advanceSession(session: ReviewSession, verdict: "keep" | "flag"): ReviewSession {
  const card = sessionCard(session);
  return card === "summary"
    ? session
    : { ...session, index: session.index + 1, verdicts: { ...session.verdicts, [card]: verdict } };
}
export function backSession(session: ReviewSession): ReviewSession {
  if (session.index === 0) return session;
  const index = session.index - 1,
    card = session.snapshot.cards[index];
  const verdicts = { ...session.verdicts };
  if (card) delete verdicts[card];
  return { ...session, index, verdicts };
}
export function sessionAgenda(session: ReviewSession) {
  return session.snapshot.cards
    .filter((card) => session.verdicts[card] === "flag" || session.notes[card]?.trim())
    .map((card) => ({ card, note: session.notes[card]?.trim() || null }));
}
