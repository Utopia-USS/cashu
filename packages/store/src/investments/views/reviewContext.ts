/** Native plain review context. The MCP surface later adds labels and privacy processing. */

import type { UiLang } from "@cashu/domain/core";
import type { market } from "@cashu/domain/investments";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import * as views from "@cashu/domain/investments/views";
import { lastReview } from "../queries/reviews.js";
import type { Read } from "../queries/shared.js";

const { reviewContextView } = views;
type ReviewClock = views.ReviewClock;

export interface ReviewContextRequest {
  readonly clock: ReviewClock;
  readonly lang: UiLang;
  readonly config: StrategyConfig | null;
  readonly calendar: market.CalendarView | null;
}

export function readReviewContext(read: Read, request: ReviewContextRequest) {
  const last = lastReview(read, "investments") ?? null;
  return reviewContextView({ ...request, lastReview: last });
}
