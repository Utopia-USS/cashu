import { Button, Card, DateText, Modal } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { R } from "./Review.strings.js";
import { CardContent } from "./ReviewCardContent.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

export function ReviewView({ state }: { state: ReviewScreenState }) {
  const ref = useRef<HTMLElement>(null),
    pointer = useRef<{ x: number; y: number } | null>(null);

  // A new card moves focus back to the panel so the arrow keys keep driving the deck.
  useEffect(() => {
    if (state.card) ref.current?.focus();
  }, [state.card]);
  if (state.privacy) return <p>{R.privacy}</p>;
  // The research reader replaces the deck while it is open; a suspended session shows nothing.
  if (state.suspended || state.reader) return null;
  return (
    <Modal
      panelRef={ref}
      focus="panel"
      label={state.session?.snapshot.name ?? R.title}
      placement="center"
      width="xl"
      closeOnBackdrop={false}
      onClose={() => {
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
        <Button onPress={state.onClosed}>{R.close}</Button>
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
          <Card
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
          </Card>
          {state.card !== "summary" && (
            <div className="my-4 flex flex-wrap gap-3">
              <Button disabled={state.pending !== null} onPress={() => state.advance("flag")}>
                {R.flag}
              </Button>
              <Button disabled={state.pending !== null} onPress={() => state.advance("keep")}>
                {R.keep}
              </Button>
              <Button onPress={() => state.setDetail(!state.detail)}>
                {state.detail ? R.hideDetails : R.details}
              </Button>
              <Button onPress={() => state.setNoteOpen(true)}>{R.note}</Button>
            </div>
          )}
          <Button
            disabled={state.session.index === 0 || state.pending !== null}
            onPress={state.back}
          >
            {R.back}
          </Button>
          <p className="mt-3 text-sm text-fg-muted">{R.keys}</p>
        </>
      )}
      {state.notice && (
        <p role="status" className="mt-3">
          {state.notice}
        </p>
      )}
    </Modal>
  );
}
