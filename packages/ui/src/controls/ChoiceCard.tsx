import type { ReactNode } from "react";

export interface ChoiceCardProps {
  checked: boolean;
  onChange(checked: boolean): void;
  title: ReactNode;
  /** The muted line under the title. */
  desc?: ReactNode;
  /** A smaller muted line below (dependencies, a note). */
  hint?: ReactNode;
  /** After the title (e.g. a `wkrótce` tag). */
  tag?: ReactNode;
  /** Shown, not selectable (faded). */
  disabled?: boolean;
}

/** A checkbox card (old ui.tsx `ChoiceCard`, `.choice`): bordered card, accent frame when checked, title 14px
 * 600 with a tag, muted 13px description, 12px hint. */
export function ChoiceCard({
  checked,
  onChange,
  title,
  desc,
  hint,
  tag,
  disabled,
}: ChoiceCardProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border bg-surface-raised px-3.5 py-3 ${checked ? "border-accent ring-1 ring-accent ring-inset" : "border-border"} ${disabled ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 accent-accent"
      />
      <div>
        <div className="flex flex-wrap items-center gap-2 text-md font-strong">
          {title}
          {tag}
        </div>
        {desc != null && <div className="mt-0.5 text-sm text-fg-muted">{desc}</div>}
        {hint != null && <div className="mt-1.5 text-xs text-fg-muted">{hint}</div>}
      </div>
    </label>
  );
}

export interface ChoiceCardsProps {
  children: ReactNode;
}

/** The grid of choice cards (old `.choices`: auto-fit columns of at least 250px, gap 10px). */
export function ChoiceCards({ children }: ChoiceCardsProps) {
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}
    >
      {children}
    </div>
  );
}
