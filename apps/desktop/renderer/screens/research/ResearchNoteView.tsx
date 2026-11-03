import { D } from "@cashu/domain";
import { Amount, DateText } from "@cashu/ui";
import { useEffect, useRef } from "react";
import type { researchNoteDates, researchNoteFacts } from "./presentation.js";
import { S } from "./Research.strings.js";
import type { ResearchNote } from "./types.js";

export type { ResearchNote } from "./types.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent";

export function ResearchNoteView({
  note,
  dates,
  facts,
  privacy,
  onClose,
  onOpenAsset,
  onOpenTopic,
  onDismiss,
  onRestore,
  onAccept,
  onUndoAccept,
  busy,
}: {
  note: ResearchNote;
  dates: ReturnType<typeof researchNoteDates>;
  facts: ReturnType<typeof researchNoteFacts>;
  privacy: boolean;
  onClose(): void;
  onOpenAsset?(instrument: string, note: string): void;
  onOpenTopic?(key: string): void;
  onDismiss?(gid: string): void;
  onRestore?(gid: string): void;
  onAccept?(gid: string, instrument: string | null): void;
  onUndoAccept?(gid: string): void;
  busy?: boolean;
}) {
  const {
    accepted,
    candidateName,
    candidateSymbol,
    candidateExchange,
    entryType,
    context,
    criteria,
    metCount,
    sources,
  } = facts;
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return (
    <section
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={S.details}
      className="fixed inset-0 z-50 grid place-items-center bg-overlay p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="max-h-full w-full max-w-3xl overflow-auto rounded-lg border border-border bg-surface-raised p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-headline font-strong">{privacy ? S.hidden : note.title}</h2>
          <button type="button" className={button} onClick={onClose}>
            {S.close}
          </button>
        </div>
        {!privacy && (
          <>
            <p className="mt-3 whitespace-pre-wrap">{note.summary}</p>
            {note.kind === "candidate" && (
              <div className="mt-3 grid gap-1 rounded-sm bg-surface-sunken p-3 text-sm">
                {(candidateName || candidateSymbol) && (
                  <strong>
                    {candidateName ?? candidateSymbol}
                    {candidateName && candidateSymbol ? ` (${candidateSymbol})` : ""}
                    {candidateExchange ? ` · ${candidateExchange}` : ""}
                  </strong>
                )}
                {entryType && (
                  <span>
                    {S.entryType}: {entryType}
                  </span>
                )}
                {accepted && <span>{S.accepted}</span>}
                {dates.cooldown && (
                  <span>
                    {S.cooldownUntil}: <DateText value={dates.cooldown} />
                  </span>
                )}
                {note.dismissed && dates.restorable && (
                  <span>
                    {S.restorableUntil}: <DateText value={dates.restorable} />
                  </span>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-text-muted">
              <span>
                {S.observed}: <DateText value={dates.observed} />
              </span>
              <span>
                {S.expires}: <DateText value={dates.expires} />
              </span>
              <span>
                {S.createdBy}: {note.created_by}
              </span>
              {note.unread && <span>{S.unread}</span>}
              {note.expired && <span>{S.outdated}</span>}
            </div>
            {context && (
              <p className="mt-3">
                <strong>{S.context}:</strong> {context}
              </p>
            )}
            {criteria.length > 0 && (
              <div className="mt-3">
                <h3 className="font-strong">
                  {S.criteria} <Amount value={D(String(metCount))} fractionDigits={0} /> /{" "}
                  <Amount value={D(String(criteria.length))} fractionDigits={0} />
                </h3>
                <ul className="list-disc pl-5">
                  {criteria.map((item) => (
                    <li key={`${item.text}:${String(item.threshold)}`}>
                      {item.met ? S.met : S.notMet}: {item.text}
                      {item.threshold == null ? "" : ` (${String(item.threshold)})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sources.length > 0 && (
              <div className="mt-4">
                <h3 className="font-strong">{S.sources}</h3>
                <ul className="list-disc pl-5">
                  {sources.map((source) => (
                    <li key={source.key}>
                      {source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent underline"
                        >
                          {source.title}
                        </a>
                      ) : (
                        <span>{source.title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {note.instrument_id && onOpenAsset && (
                <button
                  type="button"
                  className={button}
                  onClick={() => onOpenAsset(note.instrument_id as string, note.id)}
                >
                  {S.openAsset}
                </button>
              )}
              {note.segment && onOpenTopic && (
                <button
                  type="button"
                  className={button}
                  onClick={() => onOpenTopic(note.segment as string)}
                >
                  {S.openTopic}
                </button>
              )}
              {note.kind === "candidate" && !accepted && onAccept && (
                <button
                  type="button"
                  className={button}
                  disabled={busy || note.dismissed || note.instrument_id === null}
                  onClick={() => onAccept(note.id, note.instrument_id)}
                >
                  {S.watch}
                </button>
              )}
              {note.kind === "candidate" && !accepted && note.instrument_id === null && (
                <span className="text-sm text-text-muted">{S.resolutionUnavailable}</span>
              )}
              {note.kind === "candidate" && accepted && onUndoAccept && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => onUndoAccept(note.id)}
                >
                  {S.undoWatch}
                </button>
              )}
              {!note.dismissed && onDismiss && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => onDismiss(note.id)}
                >
                  {S.dismiss}
                </button>
              )}
              {note.dismissed && onRestore && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => onRestore(note.id)}
                >
                  {S.restore}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
