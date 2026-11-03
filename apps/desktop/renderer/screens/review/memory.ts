import { create } from "zustand";
import type { ReviewSession } from "./session.js";

interface ReviewMemory {
  vault: string | null;
  saved: { review: string; session: ReviewSession; closing: string; savedAt: string } | null;
  restored: { session: ReviewSession | null; closing: string } | null;
  draft: { closing: string; startedAt: number } | null;
  clear(): void;
}
/** Window-local drafts disappear when the active vault or privacy policy changes. */
export const useReviewMemory = create<ReviewMemory>((set) => ({
  vault: null,
  saved: null,
  restored: null,
  draft: null,
  clear: () => set({ vault: null, saved: null, restored: null, draft: null }),
}));
