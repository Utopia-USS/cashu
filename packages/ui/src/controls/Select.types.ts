export interface SelectOption {
  value: string;
  /** Visible, translated text of the option. */
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange(value: string): void;
  options: readonly SelectOption[];
  /** Translated label: shown with the picker (it wraps the control, so clicking it focuses the picker) and its accessible name. */
  label: string;
  /** Keeps the label as the accessible name only, for a picker whose purpose the layout already shows (a filter bar, a table cell). */
  labelHidden?: boolean;
  /** Label beside the control instead of above it. */
  inline?: boolean;
  disabled?: boolean;
  id?: string;
  /** Ids of elements that describe the picker (a hint, a validation error), as `aria-describedby`. */
  describedBy?: string;
  testID?: string;
  /** Layout only (width, grid placement, margin) of the labelled picker; identity comes from the picker. */
  className?: string;
}
