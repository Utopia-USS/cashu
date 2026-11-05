import { useId } from "react";
import { fieldLabel, fieldLook } from "./fieldLabel.js";
import type { SelectProps } from "./Select.types.js";

/** Labelled single-choice picker over a fixed list of translated options, with the shared field look. */
export function Select({
  value,
  onChange,
  options,
  label,
  labelHidden,
  inline,
  disabled,
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
      data-testid={testID}
      onChange={(event) => onChange(event.target.value)}
      className={`${fieldLook("select", !labelHidden && !inline)} ${labelHidden ? className : ""}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
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
