import { DateText } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { R } from "./Review.strings.js";
import { CardContent } from "./ReviewCardContent.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const panel = "rounded-lg border border-border bg-surface-raised p-4";
export function ReviewView({ state }: { state: ReviewScreenState }) {
  const ref = useRef<HTMLDialogElement>(null),
    pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const element = ref.current,
      previous = document.activeElement;
    if (!state.privacy && !state.suspended && !state.reader && !element?.open) element?.showModal();
    if ((state.privacy || state.suspended || state.reader) && element?.open) element.close();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [state.privacy, state.suspended, state.reader]);
  useEffect(() => {
    if (state.card) ref.current?.focus();
  }, [state.card]);
  if (state.privacy) return <p>{R.privacy}</p>;
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-label={state.session?.snapshot.name ?? R.title}
      className="m-auto max-h-full w-full max-w-4xl overflow-auto rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
      onCancel={(event) => {
        event.preventDefault();
        if (state.noteOpen) state.setNoteOpen(false);
        else if (state.detail) state.setDetail(false);
        else state.onClosed();
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]"))
          return;
        if (state.reader || state.noteOpen) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          state.advance("keep");
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          state.advance("flag");
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          state.setDetail(true);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          state.setDetail(false);
        } else if (event.key.toLowerCase() === "n" && state.card !== "summary") {
          event.preventDefault();
          state.setNoteOpen(true);
        } else if (event.key.toLowerCase() === "z" || event.key === "Backspace") {
          event.preventDefault();
          state.back();
        }
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-headline font-strong">{state.session?.snapshot.name ?? R.title}</h2>
        <button type="button" className={button} onClick={state.onClosed}>
          {R.close}
        </button>
      </header>
      {state.data.status !== "current" && <p role="status">{R.unavailable}</p>}
      {state.session && (
        <>
          <p className="my-3">
            <DateText value={state.session.snapshot.digest.since} /> -{" "}
            <DateText value={state.session.snapshot.today} />
          </p>
          <nav className="my-3 flex flex-wrap gap-2" aria-label={R.summary}>
            {state.session.snapshot.cards.map((id) => (
              <span key={id} aria-current={id === state.card ? "step" : undefined}>
                {R[id]}{" "}
                {state.session?.verdicts[id]
                  ? state.session.verdicts[id] === "flag"
                    ? R.flagged
                    : R.kept
                  : ""}
              </span>
            ))}
          </nav>
          <section
            className={panel}
            onPointerDown={(event) => {
              if (!(event.target as HTMLElement).closest("button,a,input,textarea,select"))
                pointer.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              const start = pointer.current;
              pointer.current = null;
              if (
                start &&
                Math.abs(event.clientX - start.x) > 100 &&
                Math.abs(event.clientY - start.y) < 80
              )
                state.advance(event.clientX > start.x ? "keep" : "flag");
            }}
          >
            <h3 className="mb-3 text-title font-strong">{R[state.card]}</h3>
            <CardContent state={state} />
          </section>
          {state.card !== "summary" && (
            <div className="my-4 flex flex-wrap gap-3">
              <button
                type="button"
                className={button}
                disabled={state.pending !== null}
                onClick={() => state.advance("flag")}
              >
                {R.flag}
              </button>
              <button
                type="button"
                className={button}
                disabled={state.pending !== null}
                onClick={() => state.advance("keep")}
              >
                {R.keep}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => state.setDetail(!state.detail)}
              >
                {state.detail ? R.hideDetails : R.details}
              </button>
              <button type="button" className={button} onClick={() => state.setNoteOpen(true)}>
                {R.note}
              </button>
            </div>
          )}
          <button
            type="button"
            className={button}
            disabled={state.session.index === 0 || state.pending !== null}
            onClick={state.back}
          >
            {R.back}
          </button>
          <p className="mt-3 text-sm text-fg-muted">{R.keys}</p>
        </>
      )}
      {state.notice && (
        <p role="status" className="mt-3">
          {state.notice}
        </p>
      )}
    </dialog>
  );
}
