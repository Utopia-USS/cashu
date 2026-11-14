export interface SegProps<T extends string | number | null> {
  /** The choices as [visible label, value]. */
  items: readonly (readonly [label: string, value: T])[];
  value: T;
  onChange(value: T): void;
  /** Quiet look: the selected item on the chip fill (dashboards) instead of the accent (desktop only; the
   * phone's track is always quiet). */
  quiet?: boolean;
  /** Stretch over the full width, the segments sharing it equally. */
  full?: boolean;
  /** Accessible name of the group. */
  label?: string;
  /** The whole group is read-only; `title` says why. */
  disabled?: boolean;
  title?: string;
  /** Layout only. */
  className?: string;
}
