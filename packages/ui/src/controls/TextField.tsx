import { useId } from "react";
import { fieldLabel, fieldLook } from "./fieldLabel.js";
import type { TextFieldProps } from "./TextField.types.js";

/** Labelled single- or multi-line text entry with the shared field look, invalid state and keyboard focus ring. */
export function TextField({
  value,
  onChange,
  onBlur,
  onFocus,
  label,
  labelHidden,
  inline,
  type = "text",
  multiline,
  rows,
  inputMode,
  autoComplete,
  spellCheck,
  placeholder,
  maxLength,
  min,
  max,
  pattern,
  required,
  disabled,
  invalid,
  id,
  name,
  describedBy,
  testID,
  autoFocus,
  suggestions,
  combobox,
  onKeyDown,
  className = "",
  ref,
}: TextFieldProps) {
  const ownId = useId();
  const controlId = id ?? ownId;
  const shared = {
    id: controlId,
    name,
    value,
    placeholder,
    maxLength,
    required,
    disabled,
    autoComplete,
    spellCheck,
    inputMode,
    onBlur,
    onFocus,
    onKeyDown,
    "aria-label": labelHidden ? label : undefined,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
    "data-testid": testID,
    "data-autofocus": autoFocus ? "" : undefined,
    className: `${fieldLook(multiline ? "textarea" : "input", !labelHidden && !inline)} placeholder:text-fg-muted aria-[invalid=true]:border-negative ${labelHidden ? className : ""}`,
  };
  const control = multiline ? (
    <textarea {...shared} rows={rows} onChange={(event) => onChange(event.target.value)} />
  ) : (
    <input
      {...shared}
      ref={ref}
      type={type}
      min={min}
      max={max}
      pattern={pattern}
      list={suggestions}
      role={combobox ? "combobox" : undefined}
      aria-controls={combobox?.controls}
      aria-expanded={combobox?.expanded}
      onChange={(event) => onChange(event.target.value)}
    />
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
