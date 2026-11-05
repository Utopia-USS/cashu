import type { KeyboardEventHandler, ReactNode, Ref } from "react";

export interface TextFieldProps {
  value: string;
  onChange(value: string): void;
  onBlur?(): void;
  onFocus?(): void;
  /** Translated label: shown with the field (it wraps the control, so clicking it focuses the field) and its accessible name. */
  label: string;
  /** Keeps the label as the accessible name only, for a field whose purpose the layout already shows (a filter bar, a table cell). */
  labelHidden?: boolean;
  /** Label beside the control instead of above it. */
  inline?: boolean;
  /** Kind of value: drives the desktop input type and the native keyboard / secure entry. */
  type?: "text" | "number" | "date" | "password" | "url" | "search";
  /** A multi-line field (a note, a thesis); `rows` sets its visible height. */
  multiline?: boolean;
  rows?: number;
  /** Virtual keyboard hint, independent of `type` (an amount typed as text uses `decimal`). */
  inputMode?: "text" | "decimal" | "numeric" | "email" | "url" | "search" | "tel";
  autoComplete?: string;
  spellCheck?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Bounds of a `number` or `date` field. */
  min?: string;
  max?: string;
  /** Desktop only: a validation pattern for the browser's own form check. */
  pattern?: string;
  required?: boolean;
  disabled?: boolean;
  /** Marks the value as rejected (shown with the negative border, announced as invalid). */
  invalid?: boolean;
  id?: string;
  name?: string;
  /** Ids of elements that describe the field (a hint, a validation error), as `aria-describedby`. */
  describedBy?: string;
  testID?: string;
  /** Takes the initial focus when the field opens in a `Modal`. */
  autoFocus?: boolean;
  /** Desktop only: id of a `<datalist>` with suggestions. */
  suggestions?: string;
  /** Desktop only: makes the field the input of a combobox whose listbox has the id `controls`. */
  combobox?: { controls: string; expanded: boolean };
  /** Desktop only: key handling (a combobox moving through its options, Escape clearing a search). */
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  /** Desktop only: controls on the control's row (old `.drawer .inline`: the input grows, e.g. a unit `Seg` or a
   * `wyczyść` link). With `trailing`, `before` or `after` the label wraps its text only. */
  trailing?: ReactNode;
  /** Desktop only: lines between the label and the control (old `.fhint` inside a `.field`). */
  before?: ReactNode;
  /** Desktop only: lines under the control (old `.field .fe` error, `.fhint`). */
  after?: ReactNode;
  /** Desktop only: a figure entry, right aligned with tabular digits (old `input.num`). */
  numeric?: boolean;
  /** Desktop only: tooltip of the control. */
  title?: string;
  /** Layout only (width, grid placement, margin) of the labelled field; identity comes from the field. */
  className?: string;
  /** The DOM input of a single-line field on desktop, for focus management; ignored on native. */
  ref?: Ref<HTMLInputElement>;
}
