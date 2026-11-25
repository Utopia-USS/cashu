import type { ReactNode } from "react";
import { Modal } from "./Modal.js";
import { S } from "./overlay.strings.js";

/** The close glyph of the old `.icon-btn` and the crumb separator (symbols, not words). */
const CLOSE_GLYPH = "✕";
const SEP = " › ";
/** The key cap next to the close button (a key name, not a word). */
const ESC_KEY = "Esc";

export interface DetailDrawerProps {
  /** The current item: the crumb's bold last step and the dialog's accessible name. */
  name: string;
  /** Accessible name of the crumb navigation (e.g. "Ścieżka"). */
  crumbLabel: string;
  /** The crumb's first step (e.g. "Inwestycje"), a button. */
  root: string;
  /** The crumb's middle step (e.g. "Aktywa", "Tematy"), a button. */
  section: string;
  /** A crumb step was pressed: `home` for the root, `section` for the middle step. */
  onCrumb(where: "home" | "section"): void;
  onClose(): void;
  /** The link before the key cap (e.g. "otwórz jako stronę"); absent: no link. */
  pageLink?: { label: string; onPress(): void };
  children: ReactNode;
}

const crumbStep =
  "cursor-pointer border-0 bg-transparent p-0 text-fg-muted hover:text-accent hover:underline";

/** Wide detail drawer over the page (old AssetDrawer: `.ascrim` + `.adrawer` on the page colour, 920px or the
 * window less 120px, full width at <= 760px; `.adh` head = crumb `root › section › name`, spacer, page link,
 * `Esc` key cap, close). The panel takes the focus; Esc, the scrim, the close button and browser back close it;
 * Tab stays inside; the page does not scroll; focus returns to the opener. */
export function DetailDrawer({
  name,
  crumbLabel,
  root,
  section,
  onCrumb,
  onClose,
  pageLink,
  children,
}: DetailDrawerProps) {
  return (
    <Modal label={name} onClose={onClose} placement="panel" focus="panel">
      <div className="mb-3 flex items-center gap-2.5 text-xs-plus text-fg-muted">
        <nav aria-label={crumbLabel} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="max-narrow:hidden">
            <button type="button" className={crumbStep} onClick={() => onCrumb("home")}>
              {root}
            </button>
            {SEP}
            <button type="button" className={crumbStep} onClick={() => onCrumb("section")}>
              {section}
            </button>
            {SEP}
          </span>
          <b className="font-strong text-fg">{name}</b>
        </nav>
        <span className="flex-1" />
        {pageLink && (
          <button
            type="button"
            onClick={pageLink.onPress}
            className="cursor-pointer border-0 bg-transparent p-0 text-sm text-accent underline underline-offset-2 max-narrow:whitespace-nowrap"
          >
            {pageLink.label}
          </button>
        )}
        <span aria-hidden="true" className="inline-flex max-narrow:hidden">
          <kbd className="rounded-xs border border-border px-1.25 font-mono text-2xs leading-control text-fg-muted">
            {ESC_KEY}
          </kbd>
        </span>
        <button
          type="button"
          title={S.closeEsc}
          aria-label={S.close}
          onClick={onClose}
          className="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-base leading-control text-fg-muted hover:text-fg"
        >
          {CLOSE_GLYPH}
        </button>
      </div>
      {children}
    </Modal>
  );
}
