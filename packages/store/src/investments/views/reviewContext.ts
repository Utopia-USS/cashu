/** Native plain review context. The MCP surface later adds labels and privacy processing. */
import { investments as inv } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import { lastReview } from "../queries/reviews.js";
import type { Read } from "../queries/shared.js";

const { reviewContextView } = inv.views;
type ReviewClock = inv.views.ReviewClock;

export interface ReviewContextRequest {
  readonly clock: ReviewClock;
  readonly lang: UiLang;
  readonly config: StrategyConfig | null;
  readonly calendar: inv.market.CalendarView | null;
}

export function readReviewContext(read: Read, request: ReviewContextRequest) {
  const last = lastReview(read, "investments") ?? null;
  return reviewContextView({ ...request, lastReview: last });
}
