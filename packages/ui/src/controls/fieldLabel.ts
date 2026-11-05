/** Layout and text of the `<label>` that wraps a field: stacked like the Python app's `.field` (12px muted
 * caption, 4px gap) or side by side like its `.inline` rows. */
export const fieldLabel = (inline: boolean | undefined) =>
  inline
    ? "inline-flex items-center gap-2 text-xs text-fg-muted"
    : "grid gap-1 text-xs text-fg-muted";

const face =
  "rounded-control border border-border bg-chip text-fg font-regular focus:border-accent focus-visible:outline-none disabled:opacity-60";

/** Shared look of the text field and picker controls (old `input` / `select` / `textarea`): chip face,
 * accent border on focus. Inside a visible stacked label they take the `.field` size (13px, 6px 9px);
 * bare (hidden or inline label) an input is 13px 5px 9px and a select 12px 4px 8px. */
export function fieldLook(
  kind: "input" | "select" | "textarea",
  stacked: boolean,
  compact?: boolean,
): string {
  if (compact) return `${face} max-w-55 px-1.5 py-0.5 text-xs`;
  if (kind === "textarea") return `${face} w-full resize-y px-2.25 py-1.5 text-sm`;
  if (stacked) return `${face} px-2.25 py-1.5 text-sm`;
  return kind === "select" ? `${face} px-2 py-1 text-xs` : `${face} px-2.25 py-1.25 text-sm`;
}
