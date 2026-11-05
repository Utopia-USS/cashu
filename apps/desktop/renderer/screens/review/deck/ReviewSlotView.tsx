// The review button at the right of the portfolio hero (old reviewDeck.css `.rv-*`, ReviewDeck.tsx:99-121 and
// Home.tsx `.rv-slot`): a round icon button with the deck glyph, a red badge with the card count while due, and
// "cofnij" in front of it within the undo window of a review saved here.
import { S as H } from "@cashu/i18n/investments/v2/Home.strings";
import type { ReviewSlotModel } from "./reviewSlotModel.js";

// `.rv-slot`: margin-left auto, vertically centred, gap 10px.
const slot = "ml-auto flex items-center gap-2.5 self-center";
// `.rv-btn` (+ `.due`): 48px circle, card face (`--rv-bg`), 1px border, muted glyph; hover text + muted border.
// A bare button: UA line height and weight.
const button =
  "relative grid size-12 cursor-pointer place-items-center rounded-full border border-border bg-surface-raised p-0 font-regular leading-control hover:border-fg-muted hover:text-fg";
// `.rv-badge`: red pill top -3px right -4px, 20px high, white 11px 700, a 2px card-coloured ring.
const badge =
  "absolute -top-0.75 -right-1 h-5 min-w-5 rounded-md bg-negative px-1.25 text-center text-2xs font-bold leading-5 text-on-accent tabular-nums ring-2 ring-surface-raised";
// `.lnk` with the inline font-size 12px.
const undo =
  "cursor-pointer border-0 bg-transparent p-0 text-xs text-accent underline underline-offset-2";

/** The review's glyph: a hand of three cards, the front one upright (each card covers the one behind). */
function DeckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-6.5 fill-surface-raised stroke-current"
      strokeWidth="1.5"
    >
      <rect x="8.25" y="3.5" width="7.5" height="11.5" rx="1.6" transform="rotate(-24 12 21)" />
      <rect x="8.25" y="3.5" width="7.5" height="11.5" rx="1.6" transform="rotate(24 12 21)" />
      <rect x="8.25" y="2.5" width="7.5" height="11.5" rx="1.6" />
    </svg>
  );
}

/** `button.rv-btn`: opens the deck. */
function ReviewButtonView({ slot: s }: { slot: ReviewSlotModel }) {
  return (
    <button
      type="button"
      className={`${button} ${s.due ? "text-fg" : "text-fg-muted"}`}
      aria-label={s.label}
      title={s.title}
      onClick={s.onOpen}
    >
      <DeckGlyph />
      {s.badge != null && (
        <span className={badge} aria-hidden="true">
          {s.badge}
        </span>
      )}
    </button>
  );
}

/** `div.rv-slot`: the hero's last child. */
export function ReviewSlotView({ slot: s }: { slot: ReviewSlotModel }) {
  return (
    <div className={slot}>
      {s.onUndo && (
        <button type="button" className={undo} onClick={s.onUndo}>
          {H.undoLower}
        </button>
      )}
      <ReviewButtonView slot={s} />
    </div>
  );
}
