import { reviewNotesSchema } from "@cashu/store/investments/review-screen";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { R } from "./Review.strings.js";

/** A separately mounted form uses the immutable saved card draft as its defaults. */
export function ReviewNoteForm({
  initial,
  onSaved,
  onClosed,
}: {
  initial: string;
  onSaved(note: string): void;
  onClosed(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const form = useForm({
    defaultValues: { note: initial },
    validators: { onChange: z.object({ note: reviewNotesSchema }) },
    onSubmit: ({ value }) => onSaved(value.note),
  });
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={R.note}
      onCancel={(event) => {
        event.preventDefault();
        onClosed();
      }}
      className="m-auto w-full max-w-xl rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
    >
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="note">
          {(field) => (
            <label className="grid gap-2">
              {R.note}
              <textarea
                autoFocus
                className="rounded-sm border border-border bg-surface p-3"
                value={field.state.value}
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={field.state.meta.errors.length ? "review-note-error" : undefined}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              {field.state.meta.errors.length > 0 && (
                <p id="review-note-error" role="alert">
                  {R.noteTooLong}
                </p>
              )}
            </label>
          )}
        </form.Field>
        <div className="flex gap-3">
          <form.Subscribe selector={(value) => value.isValid}>
            {(valid) => (
              <button
                disabled={!valid}
                className="rounded-sm border border-border p-2"
                type="submit"
              >
                {R.saveNote}
              </button>
            )}
          </form.Subscribe>
          <button className="rounded-sm border border-border p-2" type="button" onClick={onClosed}>
            {R.cancel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
