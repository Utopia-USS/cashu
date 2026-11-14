// The statement figure: one big formatted amount with the currency small and muted and the decimals dimmed
// (design/desktop/investments-home/lab.html V5 Statement, design/desktop/overview/layered-tiles.html `.hv`).
// Promoted from the investments home's hero on its second use (the overview's net worth tile).
import { BANANA } from "@cashu/i18n/values";

/** A formatted amount split for the statement figure: the currency before / after it, the whole part and the
 * decimals. Joined, the parts are exactly the input. */
export interface StatementParts {
  pre: string;
  main: string;
  fraction: string;
  post: string;
}

const FIGURE = /^([^\d+\-−]*)([+\-−]?\d[\d\s  .,]*?)([.,]\d{2})?(\s*[^\d]*)$/u;

/** Splits a formatted amount ("61 789,61 zł" -> "", "61 789", ",61", " zł"; "PLN 1,234.50" -> "PLN ",
 * "1,234", ".50", ""). Null when the text has no such shape (privacy mode masks the digits). */
export function statementParts(value: string): StatementParts | null {
  const m = FIGURE.exec(value);
  if (!m) return null;
  return { pre: m[1] ?? "", main: m[2] ?? "", fraction: m[3] ?? "", post: m[4] ?? "" };
}

export interface StatementFigureProps {
  /** The formatted amount (already privacy-masked by its formatter). */
  value: string;
  /** `page` (default): the page statement, 64px. `tile`: inside a layered tile, 56px, the currency 18px. */
  size?: "page" | "tile";
}

const looks = {
  page: {
    figure: "text-statement",
    currency: "align-top text-4xl font-strong tracking-heading text-fg-muted",
  },
  tile: {
    figure: "text-statement-tile",
    currency: "align-top text-lg-plus font-strong tracking-normal text-fg-muted",
  },
} as const;

/** The statement figure: bold, tight, tabular; the currency small and muted at the top, the decimals dimmed.
 * Its text stays the formatted value (tests and screen readers read it whole). */
export function StatementFigure({ value, size = "page" }: StatementFigureProps) {
  const look = looks[size];
  const parts = statementParts(value);
  // The privacy mode's banana is the figure's unit, not a currency: it scales with the digits.
  const unit = (text: string) => (text.includes(BANANA) ? "" : look.currency);
  return (
    <span
      className={`whitespace-nowrap font-bold leading-none tracking-dense text-fg tabular-nums ${look.figure}`}
    >
      {parts ? (
        <>
          {parts.pre && <span className={unit(parts.pre)}>{parts.pre}</span>}
          {parts.main}
          {parts.fraction && <span className="text-fg-muted">{parts.fraction}</span>}
          {parts.post && <span className={unit(parts.post)}>{parts.post}</span>}
        </>
      ) : (
        value
      )}
    </span>
  );
}
