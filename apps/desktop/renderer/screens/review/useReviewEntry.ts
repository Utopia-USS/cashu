import { lang } from "@cashu/i18n";
import { reviewScreenQueries, undoSavedReview } from "@cashu/store/investments/review-screen";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { parseServerTime } from "@cashu/ui-logic/core/time";
import { useEffect, useState } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useReviewMemory } from "./memory.js";
import { reviewDisplayDay } from "./presentation.js";
import { useReviewLifetime } from "./useReviewLifetime.js";

const queries = reviewScreenQueries();
export function useReviewEntry(onOpened?: () => void) {
  const vault = useProfile(),
    { privacy } = useUiEnv();
  const data = useQuery(queries.screen, {
    today: useCalendarDay(),
    lang: lang(),
    open: false,
    privacy,
  });
  const undoCommand = useCommand(undoSavedReview);
  const captureLifetime = useReviewLifetime(vault, privacy);
  const [failure, setFailure] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const memory = useReviewMemory.getState();
    if (privacy || (memory.vault !== null && memory.vault !== vault)) memory.clear();
  }, [privacy, vault]);
  const last = data.status === "current" ? data.last : null;
  const canUndo =
    last !== null &&
    now - parseServerTime(last.doneAt) <= 15 * 60000 &&
    now >= parseServerTime(last.doneAt);
  const undo = async () => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    if (!last || undoCommand.isPending || privacy) return;
    const memory = useReviewMemory.getState();
    const result = await undoCommand.run({ review: last.gid });
    if (!isCurrent()) return;
    if (!result.ok) {
      setFailure(true);
      return;
    }
    useReviewMemory.setState({
      vault,
      saved: null,
      restored: {
        session: memory.saved?.review === last.gid ? memory.saved.session : null,
        closing: last.notes ?? "",
      },
    });
    setFailure(false);
    onOpened?.();
  };
  return {
    data,
    privacy,
    lastOn: reviewDisplayDay(last?.doneAt ?? null),
    canUndo,
    undo,
    busy: undoCommand.isPending,
    failure,
  };
}
export type ReviewEntryState = ReturnType<typeof useReviewEntry>;
