export interface SelectOption {
  value: string;
  /** Visible, translated text of the option. */
  label: string;
  disabled?: boolean;
  /** Group heading: consecutive options with the same group render inside one `optgroup` (web). */
  group?: string;
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
  /** Tooltip of the picker (desktop). */
  title?: string;
  /** The compact face of a picker inside a text line (old `.ahead .hmeta select.sgsel`: 2px 6px, at most 220px). */
  compact?: boolean;
  id?: string;
  /** Ids of elements that describe the picker (a hint, a validation error), as `aria-describedby`. */
  describedBy?: string;
  testID?: string;
  /** Layout only (width, grid placement, margin) of the labelled picker; identity comes from the picker. */
  className?: string;
}
