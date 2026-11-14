// The review's entry in the portfolio hero (design V5, was the round deck button of old reviewDeck.css `.rv-*`,
// ReviewDeck.tsx:99-121 and Home.tsx `.rv-slot`): the page's one primary button, a 40px ink button with the AI
// sparkle, the review's name and, while due, the number of items to decide; hovering or focusing it shows the
// review's breakdown in a small popover (150ms intent, grows from the button, a shorter exit). "cofnij" in front of
// it within the undo window of a review saved here.
import { S as H } from "@cashu/i18n/investments/v2/Home.strings";
import { useId } from "react";
import type { ReviewSlotModel } from "./reviewSlotModel.js";

const slot = "flex items-center gap-2.5";
// The ink button (design V5 `.btn.primary.lg`): 40px, radius 10, the text colour as the face; scales to 0.97 on press.
const button =
  "group/rv-btn inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border-0 bg-fg py-0 pl-3.5 text-sm-plus font-strong text-fg-inverse transition-transform duration-150 hover:opacity-90 active:scale-97";
// The count on the button: a dark chip with the number of items to decide.
const count =
  "ml-1 inline-grid h-6 min-w-6 place-items-center rounded-sm-plus bg-surface px-1.5 text-2xs-plus font-strong text-fg tabular-nums";
// The popover (design V5 `.pop.rv-pop`): from the button's top right, at 0.95 while closed; opens after 150ms of
// hover or at once on keyboard focus, closes faster than it opens.
const pop =
  "pointer-events-none absolute top-full right-0 z-30 mt-1.5 grid w-57.5 origin-top-right scale-95 gap-1.5 rounded-md border border-border-strong bg-surface-overlay px-3.5 py-3 text-xs-plus leading-normal text-fg-secondary opacity-0 shadow-tip transition duration-150 ease-in group-hover/rv:scale-100 group-hover/rv:opacity-100 group-hover/rv:delay-150 group-hover/rv:duration-200 group-hover/rv:ease-out group-focus-within/rv:scale-100 group-focus-within/rv:opacity-100 group-focus-within/rv:duration-200 group-focus-within/rv:ease-out";
const dot = {
  negative: "bg-negative",
  positive: "bg-positive",
  neutral: "bg-fg-muted",
  info: "bg-accent",
  warning: "bg-warning",
} as const;
// `.lnk` with the inline font-size 12px.
const undo =
  "cursor-pointer border-0 bg-transparent p-0 text-xs text-accent underline underline-offset-2";

/** The AI sparkle (design V5 `I.sparkle`): a large and a small four-pointed star. */
function Sparkle() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 flex-none fill-none stroke-current transition-transform duration-300 group-hover/rv-btn:rotate-14 group-hover/rv-btn:scale-108"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 2.5c.45 2.75 1.5 3.8 4.25 4.25C8 7.2 6.95 8.25 6.5 11 6.05 8.25 5 7.2 2.25 6.75 5 6.3 6.05 5.25 6.5 2.5Z" />
      <path d="M12 9.75c.22 1.2.55 1.53 1.75 1.75-1.2.22-1.53.55-1.75 1.75-.22-1.2-.55-1.53-1.75-1.75 1.2-.22 1.53-.55 1.75-1.75Z" />
    </svg>
  );
}

/** The review button with its popover: opens the deck. `open` pins the popover (stories, screenshots). */
function ReviewButtonView({ slot: s, open }: { slot: ReviewSlotModel; open?: boolean }) {
  const popId = useId();
  return (
    <span className="group/rv relative inline-flex">
      <button
        type="button"
        className={`${button} ${s.badge == null ? "pr-3.5" : "pr-2"}`}
        aria-label={s.label}
        aria-describedby={popId}
        title={s.title}
        onClick={s.onOpen}
      >
        <Sparkle />
        <span>{s.name}</span>
        {s.badge != null && (
          <span className={count} aria-hidden="true">
            {s.badge}
          </span>
        )}
      </button>
      <span id={popId} role="tooltip" className={`${pop} ${open ? "scale-100 opacity-100" : ""}`}>
        <b className="mb-0.5 font-medium text-fg">{s.pop.title}</b>
        {s.pop.rows.map((r) => (
          <span
            key={r.key}
            className={`flex items-center gap-2 ${r.dim ? "text-fg-muted" : "text-fg"}`}
          >
            <i aria-hidden="true" className={`size-1.5 flex-none rounded-full ${dot[r.tone]}`} />
            {r.text}
          </span>
        ))}
        {s.pop.when && (
          <span className="mt-1 border-t border-border pt-2 text-xs text-fg-muted">
            {s.pop.when}
          </span>
        )}
      </span>
    </span>
  );
}

/** The slot at the hero's right end: the undo link and the review button. */
export function ReviewSlotView({ slot: s, open }: { slot: ReviewSlotModel; open?: boolean }) {
  return (
    <div className={slot}>
      {s.onUndo && (
        <button type="button" className={undo} onClick={s.onUndo}>
          {H.undoLower}
        </button>
      )}
      <ReviewButtonView slot={s} open={open} />
    </div>
  );
}
