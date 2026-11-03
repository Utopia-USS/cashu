import { D } from "@cashu/domain";
import { Amount, DateText } from "@cashu/ui";
import { R } from "./Review.strings.js";
import type { ReviewEntryState } from "./useReviewEntry.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
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
      <button type="button" className={button} onClick={onOpened}>
        {state.data.name}{" "}
        {state.data.due && (
          <>
            <span>{R.due}</span>{" "}
            <Amount value={D(String(state.data.cards.length))} fractionDigits={0} />
          </>
        )}
      </button>
      {state.data.last && (
        <span>
          {R.last}: <DateText value={state.lastOn} />
        </span>
      )}
      <span>
        {R.next}: <DateText value={state.data.next} />
      </span>
      {state.canUndo && (
        <button
          type="button"
          className={button}
          disabled={state.busy}
          onClick={() => void state.undo()}
        >
          {R.undo}
        </button>
      )}
      {state.failure && <p role="status">{R.failed}</p>}
    </section>
  );
}
