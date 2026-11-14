import { Fragment, type ReactNode } from "react";

export interface CrumbItem {
  /** The step's text (unique within the line). */
  label: string;
  /** Set: the step is a button (back to that level); unset: the current page, plain text. */
  onPress?: () => void;
}

export interface CrumbProps {
  /** Accessible name of the navigation landmark (e.g. "Ścieżka"). */
  label: string;
  /** The steps, first to current, joined by `›`. */
  items: readonly CrumbItem[];
  /** After a spacer at the right end (e.g. a link that opens the same view in the panel). */
  end?: ReactNode;
  /** A link at the right end (old `.lnk` inside `.crumb`: the crumb's muted button, always underlined). */
  endLink?: { label: string; onPress(): void };
}

/** The step separator (a symbol, not a word). */
const SEP = " \u203a ";
const step =
  "cursor-pointer border-0 bg-transparent p-0 text-fg-muted hover:text-accent hover:underline";

/** Breadcrumb line above a sub-page (old `.crumb`: 12.5px muted, 6px gaps, bare buttons that turn accent and
 * underlined on hover, the current step as plain text). */
export function Crumb({ label, items, end, endLink }: CrumbProps) {
  return (
    <nav
      aria-label={label}
      className="mb-2 flex flex-wrap items-center gap-1.5 text-xs-plus text-fg-muted"
    >
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 && SEP}
          {item.onPress ? (
            <button type="button" className={step} onClick={item.onPress}>
              {item.label}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
        </Fragment>
      ))}
      {(end != null || endLink) && (
        <>
          <span className="flex-1" />
          {end}
          {endLink && (
            <button
              type="button"
              className={`${step} underline underline-offset-2`}
              onClick={endLink.onPress}
            >
              {endLink.label}
            </button>
          )}
        </>
      )}
    </nav>
  );
}
