import { C } from "@cashu/i18n/core/common.strings";
import { Notice } from "../surfaces/Notice.js";

/** The disclosure triangles of the old `.more summary` (symbols, not words). */
const CLOSED = "▸ ";
const OPEN = "▾ ";
const DOT = " · ";

export interface RunErrorProps {
  /** The one line of the failure kind (bold). */
  title: string;
  /** The connector or job it came from, after a dot. */
  source?: string | null;
  /** The connector's own message. */
  message?: string | null;
  /** Technical detail (a stderr tail) behind `Szczegóły`; owner UI only. */
  details?: string | null;
  /** Details open from the start. */
  open?: boolean;
  /** Layout only (margin; default the Notice's 12px below). */
  className?: string;
}

/** One block for a run failure (old core/RunError.tsx): a negative notice with the bold kind line, the source,
 * the message and the details disclosure (old `details.more` with a `pre.diff`). */
export function RunError({ title, source, message, details, open, className }: RunErrorProps) {
  return (
    <Notice tone="negative" className={className}>
      <div>
        <b>{title}</b>
        {source ? (
          <span className="text-xs text-fg-muted">
            {DOT}
            {source}
          </span>
        ) : null}
      </div>
      {message ? <div className="mt-0.5 text-xs-plus">{message}</div> : null}
      {details ? (
        <details open={open} className="group">
          <summary className="mt-1 cursor-pointer list-none text-xs text-fg-muted [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">{CLOSED}</span>
            <span className="hidden group-open:inline">{OPEN}</span>
            {C.details}
          </summary>
          <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-chip px-2.5 py-2 font-mono text-xs leading-normal [font-variant-ligatures:none]">
            {details}
          </pre>
        </details>
      ) : null}
    </Notice>
  );
}
