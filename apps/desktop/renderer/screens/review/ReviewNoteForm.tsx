import { reviewNotesSchema } from "@cashu/store/investments/review-screen";
import { Modal } from "@cashu/ui";
import { useForm } from "@tanstack/react-form";
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
  const form = useForm({
    defaultValues: { note: initial },
    validators: { onChange: z.object({ note: reviewNotesSchema }) },
    onSubmit: ({ value }) => onSaved(value.note),
  });
  return (
    <Modal label={R.note} onClose={onClosed} placement="center" width="sm" closeOnBackdrop={false}>
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
                data-autofocus
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
    </Modal>
  );
}
