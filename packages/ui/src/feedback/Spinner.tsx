export interface SpinnerProps {
  /** Accessible name when the spinner stands alone (a section loading); omit inside a busy button. */
  label?: string;
  /** Show at once; by default it fades in after 150ms so a fast action never flashes it. The busy
   * `Button` already delays (and holds) its spinner, so it passes `immediate`. */
  immediate?: boolean;
  /** Layout only (margin, colour through `text-*`). */
  className?: string;
}

/** Small ring that turns while an action runs; sized by the surrounding font (1em) and drawn in
 * `currentColor`, so it fits a button face or a line of text. Under reduced motion it turns slower. */
export function Spinner({ label, immediate = false, className = "" }: SpinnerProps) {
  return (
    <span
      role={label === undefined ? undefined : "status"}
      className={`inline-flex shrink-0 ${immediate ? "" : "animate-spinner-in"} ${className}`}
    >
      {label !== undefined && <span className="sr-only">{label}</span>}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-[1em] animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.25"
        />
        <path
          d="M8 2a6 6 0 0 1 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
