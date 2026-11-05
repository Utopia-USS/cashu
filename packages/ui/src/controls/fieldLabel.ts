/** Layout of the `<label>` that wraps a field and its text: stacked (default) or side by side. */
export const fieldLabel = (inline: boolean | undefined) =>
  inline ? "inline-flex items-center gap-2" : "grid gap-1";

/** Shared look of the text field and picker controls: field surface, focus ring, disabled state. */
export const fieldLook =
  "rounded-sm border border-border bg-surface px-3 py-2 text-body text-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus";
