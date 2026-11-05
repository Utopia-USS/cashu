import type { ReactNode } from "react";

export interface RadioOption<T extends string> {
  value: T;
  title: ReactNode;
  desc?: ReactNode;
  /** A tag after the title (old `o.tag`, e.g. `nieskonfigurowany`). */
  tag?: ReactNode;
  /** Tooltip of the whole row (old `tooltip`), e.g. an example of the choice. */
  tooltip?: string;
  /** Shown but not selectable (old `.radios label.off`). */
  disabled?: boolean;
}

/** Radio choices as bordered rows (old `.radios`); `value` null = nothing picked yet. */
export interface RadioListProps<T extends string> {
  name: string;
  value: T | null;
  onChange(value: T): void;
  options: readonly RadioOption<T>[];
  /** Accessible name of the group. */
  label?: string;
  /** Every choice read-only (a save in flight). */
  disabled?: boolean;
}

export function RadioList<T extends string>({
  name,
  value,
  onChange,
  options,
  label,
  disabled,
}: RadioListProps<T>) {
  return (
    <div role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label
            key={option.value}
            title={option.tooltip}
            className={`mb-2 flex items-start gap-2.5 rounded-md border px-3 py-2.5 ${on ? "border-accent ring-1 ring-accent ring-inset" : "border-border"} ${option.disabled ? "cursor-default opacity-60" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={on}
              disabled={disabled || option.disabled}
              onChange={() => onChange(option.value)}
              className="mt-1 accent-accent"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2 text-md font-strong">
                {option.title}
                {option.tag}
              </div>
              {option.desc != null && <div className="text-sm text-fg-muted">{option.desc}</div>}
            </div>
          </label>
        );
      })}
    </div>
  );
}
