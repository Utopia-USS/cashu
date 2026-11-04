import { D } from "@cashu/domain";
import { Amount, Button, DateText } from "@cashu/ui";
import { R } from "./Review.strings.js";
import type { ReviewEntryState } from "./useReviewEntry.js";

export function ReviewEntryView({
  state,
  onOpened,
}: {
  state: ReviewEntryState;
  onOpened(): void;
}) {
  if (state.privacy) return null;
  if (state.data.status !== "current")
    return (
      <p className="text-sm text-fg-muted">
        {R.title}: {R.unavailable}
      </p>
    );
  if (!state.data.hasData) return null;
  return (
    <section className="flex flex-wrap items-center gap-3" aria-label={R.title}>
      <Button onPress={onOpened}>
        {state.data.name}{" "}
        {state.data.due && (
          <>
            <span>{R.due}</span>{" "}
            <Amount value={D(String(state.data.cards.length))} fractionDigits={0} />
          </>
        )}
      </Button>
      {state.data.last && (
        <span>
          {R.last}: <DateText value={state.lastOn} />
        </span>
      )}
      <span>
        {R.next}: <DateText value={state.data.next} />
      </span>
      {state.canUndo && (
        <Button disabled={state.busy} onPress={() => void state.undo()}>
          {R.undo}
        </Button>
      )}
      {state.failure && <p role="status">{state.failure}</p>}
    </section>
  );
}
