/** Review registers only existing owner writes and genuine tracked sources. */
import {
  type ReviewScreenSources,
  reviewScreenQueries,
  saveReview,
  undoSavedReview,
} from "@cashu/store/investments/review-screen";

export function reviewScreen(sources: ReviewScreenSources = {}) {
  return {
    queries: reviewScreenQueries(sources),
    commands: { save: saveReview, undo: undoSavedReview },
  };
}
