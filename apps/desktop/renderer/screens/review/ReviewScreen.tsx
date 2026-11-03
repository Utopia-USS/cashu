import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect } from "react";
import { ResearchNoteReader } from "../research/ResearchNoteReader.js";
import { useReviewMemory } from "./memory.js";
import { R } from "./Review.strings.js";
import { ReviewNoteForm } from "./ReviewNoteForm.js";
import { ReviewView } from "./ReviewView.js";
import { type ReviewScreenProps, useReviewScreen } from "./useReviewScreen.js";

export type { ReviewScreenProps } from "./useReviewScreen.js";
export function ReviewScreen(props: ReviewScreenProps) {
  const vault = useProfile(),
    { privacy } = useUiEnv();
  useEffect(() => {
    const memory = useReviewMemory.getState();
    if (privacy || (memory.vault !== null && memory.vault !== vault)) memory.clear();
  }, [vault, privacy]);
  return privacy ? <p>{R.privacy}</p> : <BoundReview key={vault} {...props} />;
}
function BoundReview(props: ReviewScreenProps) {
  const state = useReviewScreen(props);
  return (
    <>
      <ReviewView state={state} />
      {state.noteOpen && state.card !== "summary" && (
        <ReviewNoteForm
          key={state.card}
          initial={state.session?.notes[state.card] ?? ""}
          onSaved={state.saveCardNote}
          onClosed={() => state.setNoteOpen(false)}
        />
      )}
      {state.reader && (
        <ResearchNoteReader
          noteGid={state.reader}
          onClose={() => state.setReader(null)}
          onOpenAsset={props.onInstrumentOpened}
          onOpenTopic={(topic) => props.onResearchOpened?.({ topic })}
        />
      )}
    </>
  );
}
