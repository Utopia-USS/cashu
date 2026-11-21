import type { ReactNode } from "react";

export interface IconToggleProps {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Accessible name of the switch; stays the same in both states (the checked state says which). */
  label: string;
  /** Tooltip, e.g. what a press does now. */
  title?: string;
  /** The glyph (16px, drawn in `currentColor`). */
  children: ReactNode;
  /** Layout only. */
  className?: string;
}

/**
 * A round 28px on / off switch that shows only a glyph (old header `.btn.incog`): card face and muted
 * glyph when off, chip face and text-coloured glyph when on. A transparent checkbox over the whole
 * circle carries the state (it reads and clicks as a checkbox); the focus ring is drawn on the circle.
 */
export function IconToggle({
  checked,
  onChange,
  label,
  title,
  children,
  className = "",
}: IconToggleProps) {
  return (
    <label
      title={title}
      className={`relative inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border border-border outline-focus outline-offset-2 has-focus-visible:outline-2 ${checked ? "bg-chip text-fg" : "bg-surface-raised text-fg-muted hover:text-fg"} ${className}`}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-full opacity-0 outline-none"
      />
      {children}
    </label>
  );
}
