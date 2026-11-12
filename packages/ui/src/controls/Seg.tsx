import type { SegProps } from "./Seg.types.js";

export type { SegProps } from "./Seg.types.js";

/** Segmented single choice (old `.seg`, `.seg.quiet`): pressed-state buttons in one bordered strip. */
export function Seg<T extends string | number | null>({
  items,
  value,
  onChange,
  quiet,
  full,
  label,
  disabled,
  title,
  className = "",
}: SegProps<T>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset.
    <span
      role="group"
      aria-label={label}
      title={title}
      className={`${full ? "flex w-full" : "inline-flex"} overflow-hidden rounded-control border border-border ${quiet ? "bg-surface-raised" : ""} ${className}`}
    >
      {items.map(([text, item], index) => {
        const on = item === value;
        const face = on
          ? quiet
            ? "bg-chip font-strong text-fg"
            : "bg-accent text-on-accent"
          : "bg-transparent text-chip-fg";
        return (
          <button
            key={String(item)}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(item)}
            className={`${full ? "flex-1 " : ""}cursor-pointer text-xs leading-control disabled:cursor-default ${quiet ? "px-2.25 py-1" : "px-2.5 py-1.25"} ${on && quiet ? "" : "font-regular"} ${face} ${index > 0 ? "border-l border-border" : ""}`}
          >
            {text}
          </button>
        );
      })}
    </span>
  );
}
