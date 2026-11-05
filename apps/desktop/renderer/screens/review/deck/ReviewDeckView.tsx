// The weekly review deck (ab24ab6 v2/ReviewDeck.tsx:440-513, reviewDeck.css): a full-window layer over the home,
// one card at a time with the next two peeking under it, the flag / keep buttons, the key hints and the note
// sheet. Pure: renders `useReviewDeck`'s state; keys typed into a field stay with the field.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { Modal, Skeleton } from "@cashu/ui";
import { type KeyboardEvent, useEffect, useRef } from "react";
import {
  type BodyActions,
  body,
  CardBodyView,
  CardHead,
  eyebrow,
  link,
  MoreBody,
  noteLink,
  SummaryBody,
  textarea,
} from "./DeckCardParts.js";
import { deckCard, SwipeCard } from "./SwipeCard.js";
import type { DotLook, ReviewDeckState, StackEntry } from "./useReviewDeck.js";

// `.rd`: the layer's column (the Modal "screen" panel is the fixed full-window frame on --bg).
const layer =
  "absolute inset-0 flex flex-col items-center gap-2.5 overflow-hidden px-4 py-3.5 text-base leading-normal text-fg";
const column = "w-full max-w-145";
// `.rd-top` (+ `.x`, `.c .t`, `.c .s`, `.u`): bare buttons keep the UA font (Arial, line height normal,
// weight 400): the `font-control` / `text-control` tokens.
const top = `${column} grid grid-cols-[minmax(auto,1fr)_auto_minmax(auto,1fr)] items-center`;
const closeX =
  "cursor-pointer justify-self-start border-0 bg-transparent px-2 py-1 text-3xl-plus font-regular font-control leading-none text-fg-muted";
const undoBtn =
  "cursor-pointer justify-self-end border-0 bg-transparent px-2 py-1 text-control font-strong leading-control font-control text-accent disabled:cursor-default disabled:text-fg-muted disabled:opacity-50";
// `.rd-dots i` (+ `.keep`, `.flag`: the global `.flag` adds margin-left 5px, `.on`).
const dotLook: Record<DotLook, string> = {
  on: "bg-fg",
  keep: "bg-positive",
  flag: "ml-1.25 bg-net align-middle",
  "": "bg-border",
};
// `.rd-deck`: the stack, its peek kept clear of the buttons.
const deck = `${column} relative mb-4 max-h-160 min-h-0 flex-1`;
const back = [
  "",
  "pointer-events-none origin-bottom translate-y-2 scale-96 opacity-90",
  "pointer-events-none origin-bottom translate-y-4 scale-92 opacity-60",
];
// `.rd-btns` (+ `.f`, `.k`), `.rd-keys` (+ kbd).
const btns = `${column} grid grid-cols-2 gap-2.5`;
const bigBtn =
  "cursor-pointer rounded-widget border p-3 text-base font-heavy leading-control font-control";
const keys = "text-center text-2xs text-fg-muted max-phone:hidden";
const kbd = "rounded-2xs bg-chip px-1.25 font-[family-name:inherit]";
// `.rd-sheet .close`, `.rd-sheet h3`, `p`, `.srcs`.
const sheetClose =
  "float-right cursor-pointer rounded-control border-0 bg-chip px-2.5 py-1 text-xs font-regular leading-control font-control text-chip-fg";

export function ReviewDeckView({ state: s }: { state: ReviewDeckState }) {
  const panel = useRef<HTMLElement>(null);
  // The panel takes the keys again once a card has gone (old advance: `panel.current?.focus()`).
  useEffect(() => {
    if (s.index > 0) panel.current?.focus();
  }, [s.index]);
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input")) return;
    if (s.onKey(e.key)) e.preventDefault();
  };
  const actions = { onDecide: s.onDecide, onWatch: s.onWatch, onDismiss: s.onDismiss };
  return (
    <Modal
      label={s.title}
      placement="screen"
      focus="panel"
      panelRef={panel}
      onClose={s.onEscape}
      onKeyDown={onKeyDown}
      className={s.suspended ? "invisible" : ""}
    >
      <div className={layer}>
        <div className={top}>
          <button
            type="button"
            className={closeX}
            onClick={s.onClose}
            aria-label={S.closeNoSave}
            title={S.closeTitle}
          >
            ×
          </button>
          <div className="text-center">
            <div className="text-base font-heavy">{s.heading}</div>
            <div className="text-xs text-fg-muted">{s.sub}</div>
          </div>
          <button type="button" className={undoBtn} onClick={s.onUndo} disabled={!s.canUndo}>
            {C.undo}
          </button>
        </div>
        <div className={`${column} flex gap-1`} aria-hidden="true">
          {s.dots.map((look, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one segment per card position
            <i key={k} className={`h-0.75 flex-1 rounded-4xs ${dotLook[look]}`} />
          ))}
        </div>
        <div className={deck}>
          {!s.built ? (
            <div className={deckCard}>
              <div className="grid gap-3.5 px-5 py-6">
                <Skeleton height={28} width="60%" />
                <Skeleton height={140} />
                <div className="text-fg-muted">{S.building}</div>
              </div>
            </div>
          ) : (
            s.stack.map((entry) => (
              <StackCard key={entry.key} entry={entry} s={s} actions={actions} />
            ))
          )}
        </div>
        {s.showButtons && (
          <div className={btns}>
            <button
              type="button"
              className={`${bigBtn} border-border bg-surface-raised text-net`}
              onClick={() => s.onAdvance("flag")}
            >
              {S.flag}
            </button>
            <button
              type="button"
              className={`${bigBtn} border-transparent bg-positive text-surface-raised`}
              onClick={() => s.onAdvance("keep")}
            >
              {S.keep}
            </button>
          </div>
        )}
        <div className={keys}>
          <kbd className={kbd}>←</kbd>
          {S.keyFlag}
          <kbd className={kbd}>→</kbd>
          {S.keyNext}
          <kbd className={kbd}>↑</kbd>
          {S.keyMore}
          <kbd className={kbd}>N</kbd>
          {S.keyNote}
          <kbd className={kbd}>Z</kbd>
          {S.keyUndo}
        </div>
      </div>
      {s.sheet && (
        <Modal label={s.sheet.title} placement="sheet" onClose={s.onSheetClosed}>
          <button type="button" className={sheetClose} onClick={s.onSheetClosed}>
            {C.close}
          </button>
          <span className={eyebrow}>{s.sheet.eyebrow}</span>
          <h3 className="mt-1 mb-3 text-balance text-xl font-bold">{s.sheet.title}</h3>
          {s.sheet.paragraphs.map((p, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one note in order
            <p key={k} className="mt-0 mb-3 max-w-prose whitespace-pre-line">
              {p}
            </p>
          ))}
          {s.sheet.sources.length > 0 && (
            <div className="grid gap-1 border-t border-border pt-2.5 text-xs text-fg-muted">
              <b>{S.sources}</b>
              {s.sheet.sources.map((x, k) => (
                <a
                  // biome-ignore lint/suspicious/noArrayIndexKey: sources of one note in order
                  key={k}
                  href={x.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  {x.text}
                </a>
              ))}
            </div>
          )}
        </Modal>
      )}
    </Modal>
  );
}

/** One card of the stack, painted back to front (old ReviewDeck.tsx:451-485). */
function StackCard({
  entry,
  s,
  actions,
}: {
  entry: StackEntry;
  s: ReviewDeckState;
  actions: BodyActions;
}) {
  switch (entry.kind) {
    case "back":
      return <div className={`${deckCard} ${back[entry.depth] ?? ""}`} aria-hidden="true" />;
    case "peek":
      return (
        <div className={`${deckCard} ${back[1]}`} aria-hidden="true">
          <CardHead card={entry.card} />
          {entry.card.body.kind !== "decide" && entry.card.body.kind !== "ideas" && (
            <div className={body}>
              <CardBodyView body={entry.card.body} actions={actions} />
            </div>
          )}
        </div>
      );
    case "summary":
      return (
        <div className={`${deckCard} select-none`} data-card="summary">
          <div className="flex items-center gap-2 px-5 pt-4.5">
            <span className={eyebrow}>{S.summary}</span>
          </div>
          <h2 className="mx-5 mt-2 mb-0 text-balance text-3xl font-bold leading-tight tracking-snug max-phone:text-xl">
            {entry.summary.title}
          </h2>
          <SummaryBody
            summary={entry.summary}
            closing={s.closing}
            busy={s.busy}
            onClosing={s.onClosing}
            onFinish={s.onFinish}
          />
        </div>
      );
    case "top": {
      const { card } = entry;
      const has = entry.note.trim() !== "";
      return (
        <SwipeCard
          card={entry.key}
          flying={s.flying}
          onSwipe={s.onAdvance}
          stampKeep={S.stampKeep}
          stampFlag={S.stampFlag}
        >
          <CardHead card={card} />
          {!entry.detail || !card.more ? (
            <div className={body}>
              <CardBodyView body={card.body} actions={actions} />
            </div>
          ) : (
            <MoreBody more={card.more} onOpenNote={s.onOpenNote} />
          )}
          {entry.noteOpen && (
            <div className="px-5 pb-3">
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the note box opens on request (button or N) to be typed in
                autoFocus
                className={textarea}
                aria-label={S.agentNote}
                placeholder={S.agentNotePlaceholder}
                value={entry.note}
                onChange={(e) => s.onCardNote(e.target.value)}
              />
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-border px-5 pt-2.5 pb-3.5">
            {card.more &&
              (entry.detail ? (
                <button type="button" className={link} onClick={() => s.onDetail(false)}>
                  {S.backArrow}
                </button>
              ) : (
                <button type="button" className={link} onClick={() => s.onDetail(true)}>
                  {S.readMore}
                </button>
              ))}
            <button type="button" className={noteLink(has)} onClick={s.onToggleNote}>
              {has ? S.agentNoteEdit : S.agentNoteAdd}
            </button>
          </div>
        </SwipeCard>
      );
    }
  }
}
