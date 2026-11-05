import type { ReactNode } from "react";

export interface RadioOption<T extends string> {
  value: T;
  title: ReactNode;
  desc?: ReactNode;
}

/** Radio choices as bordered rows (old `.radios`); `value` null = nothing picked yet. */
export interface RadioListProps<T extends string> {
  name: string;
  value: T | null;
  onChange(value: T): void;
  options: readonly RadioOption<T>[];
}

export function RadioList<T extends string>({ name, value, onChange, options }: RadioListProps<T>) {
  return (
    <div role="radiogroup">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label
            key={option.value}
            className={`mb-2 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${on ? "border-accent ring-1 ring-accent ring-inset" : "border-border"}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={on}
              onChange={() => onChange(option.value)}
              className="mt-1 accent-accent"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2 text-md font-strong">
                {option.title}
              </div>
              {option.desc != null && <div className="text-sm text-fg-muted">{option.desc}</div>}
            </div>
          </label>
        );
      })}
    </div>
  );
}
