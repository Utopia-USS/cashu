import { useId } from "react";
import { fieldLabel, fieldLook } from "./fieldLabel.js";
import type { SelectOption, SelectProps } from "./Select.types.js";

const optionNode = (option: SelectOption) => (
  <option key={option.value} value={option.value} disabled={option.disabled}>
    {option.label}
  </option>
);

/** Consecutive options of one group (ungrouped options form runs without a heading). */
function groupsOf(options: readonly SelectOption[]) {
  const runs: { group: string | undefined; options: SelectOption[] }[] = [];
  for (const option of options) {
    const last = runs.at(-1);
    if (last && last.group === option.group) last.options.push(option);
    else runs.push({ group: option.group, options: [option] });
  }
  return runs;
}

/** Labelled single-choice picker over a fixed list of translated options, with the shared field look. */
export function Select({
  value,
  onChange,
  options,
  label,
  labelHidden,
  inline,
  disabled,
  title,
  compact,
  id,
  describedBy,
  testID,
  className = "",
}: SelectProps) {
  const ownId = useId();
  const controlId = id ?? ownId;
  const control = (
    <select
      id={controlId}
      value={value}
      disabled={disabled}
      aria-label={labelHidden ? label : undefined}
      aria-describedby={describedBy}
      title={title}
      data-testid={testID}
      onChange={(event) => onChange(event.target.value)}
      className={`${fieldLook("select", !labelHidden && !inline, compact)} ${labelHidden ? className : ""}`}
    >
      {groupsOf(options).map((run) =>
        run.group === undefined ? (
          run.options.map(optionNode)
        ) : (
          <optgroup key={`${run.group}:${run.options[0]?.value ?? ""}`} label={run.group}>
            {run.options.map(optionNode)}
          </optgroup>
        ),
      )}
    </select>
  );
  return labelHidden ? (
    control
  ) : (
    <label htmlFor={controlId} className={`${fieldLabel(inline)} ${className}`}>
      {label}
      {control}
    </label>
  );
}
