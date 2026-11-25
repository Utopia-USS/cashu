import { type ReactNode, useState } from "react";
import { RelationIcon, type RelationIconProps } from "./ResearchMarks.js";

export interface NoteSourceItem {
  /** Who published it (outlet or author); the link text. */
  who: string;
  /** A safe http(s) URL, else null (plain text). */
  url: string | null;
  /** Link tooltip (the source title or the URL). */
  title?: string;
  /** Publication date, muted after the name. */
  date?: string | null;
}

export interface NoteRowProps {
  /** DOM id (deep links scroll to it) and `data-note`. */
  id: string;
  title: string;
  /** Tooltip of the row head (kind and date). */
  tip?: string;
  relation: RelationIconProps;
  /** A tag after the title (e.g. "sprzed zmiany tezy"). */
  badge?: ReactNode;
  open: boolean;
  onToggle(): void;
  /** Dismissed or expired: the row at 62 % opacity. */
  dim?: boolean;
  /** The deep-link target: accent bar and info tint. */
  highlight?: boolean;
  /** A dismissed note that can still be restored: `text · action` right of the head. */
  restore?: { text: string; action: string; onRestore(): void };
  /** The summary shown when open (rich text nodes). */
  summary?: ReactNode;
  /** The sources toggle label (e.g. "źródła (2)") and the list it opens. */
  sources?: { label: string; items: readonly NoteSourceItem[] };
  /** `odrzuć` when open. */
  dismiss?: { label: string; onDismiss(): void };
}

/** The middle dot between the parts of a line (a symbol, not a word). */
const DOT = "\u00b7";
const DOT_SEP = " \u00b7 ";
const lnk =
  "cursor-pointer border-0 bg-transparent p-0 text-xs text-accent underline underline-offset-2";

/** One research note in an instrument context (old research `.nr`): relation icon + title (two lines, a chevron);
 * a click expands the summary, the sources toggle and the dismiss link. */
export function NoteRow({
  id,
  title,
  tip,
  relation,
  badge,
  open,
  onToggle,
  dim,
  highlight,
  restore,
  summary,
  sources,
  dismiss,
}: NoteRowProps) {
  const [src, setSrc] = useState(false);
  const hasSources = (sources?.items.length ?? 0) > 0;
  return (
    <article
      id={id}
      data-note={id}
      className={`group/nr scroll-mt-20 border-b border-border last:border-b-0 ${highlight ? "-ml-2.5 rounded-control bg-info-bg pl-2.5 shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          aria-expanded={open}
          title={tip}
          onClick={onToggle}
          className={`group/nrh grid min-w-0 flex-1 cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-0 bg-transparent py-2.25 text-left text-fg ${dim ? "opacity-62" : ""}`}
        >
          <RelationIcon {...relation} />
          <span
            className={`text-sm-plus font-strong leading-[1.35] group-hover/nrh:text-accent ${open ? "block" : "line-clamp-2"}`}
          >
            {title}
          </span>
          {badge}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className={`mt-0.75 text-fg-muted transition-transform duration-150 group-hover/nrh:text-fg ${open ? "rotate-180" : ""}`}
          >
            <path
              d="M3 4.5 6 7.5 9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {restore && (
          <span className="whitespace-nowrap pt-2.5 text-xs text-fg-muted">
            {restore.text}
            {DOT_SEP}
            <button
              type="button"
              className={lnk}
              onClick={(e) => {
                e.stopPropagation();
                restore.onRestore();
              }}
            >
              {restore.action}
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className={`grid gap-1.5 pb-2.5 pl-6.5 ${dim ? "opacity-62" : ""}`}>
          {summary != null && summary !== "" && (
            <p className="m-0 whitespace-pre-line text-xs-plus leading-normal text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums">
              {summary}
            </p>
          )}
          {(hasSources || dismiss) && (
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              {hasSources && sources && (
                <button
                  type="button"
                  className={lnk}
                  aria-expanded={src}
                  onClick={() => setSrc((v) => !v)}
                >
                  {sources.label}
                </button>
              )}
              {hasSources && dismiss && <span aria-hidden="true">{DOT}</span>}
              {dismiss && (
                <button type="button" className={lnk} onClick={dismiss.onDismiss}>
                  {dismiss.label}
                </button>
              )}
            </div>
          )}
          {src && sources && (
            <ul className="m-0 grid list-none gap-0.75 p-0 text-xs">
              {sources.items.map((s) => (
                <li key={`${s.who}:${s.url ?? ""}:${s.date ?? ""}`}>
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={s.title ?? s.url}
                      className="border-b border-border text-fg no-underline hover:border-fg"
                    >
                      {s.who}
                    </a>
                  ) : (
                    s.who
                  )}
                  {s.date && <span className="ml-1.5 text-fg-muted tabular-nums">{s.date}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
