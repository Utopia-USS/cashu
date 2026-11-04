import { D } from "@cashu/domain";
import { Amount, Button, DateText, Modal } from "@cashu/ui";
import type { researchNoteDates, researchNoteFacts } from "./presentation.js";
import { S } from "./Research.strings.js";
import type { ResearchNote } from "./types.js";

export type { ResearchNote } from "./types.js";

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
  return (
    <Modal label={S.details} onClose={onClose} focus="panel" placement="center">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-headline font-strong">{privacy ? S.hidden : note.title}</h2>
        <Button onPress={onClose}>{S.close}</Button>
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
              <Button onPress={() => onOpenAsset(note.instrument_id as string, note.id)}>
                {S.openAsset}
              </Button>
            )}
            {note.segment && onOpenTopic && (
              <Button onPress={() => onOpenTopic(note.segment as string)}>{S.openTopic}</Button>
            )}
            {note.kind === "candidate" && !accepted && onAccept && (
              <Button
                disabled={busy || note.dismissed || note.instrument_id === null}
                onPress={() => onAccept(note.id, note.instrument_id)}
              >
                {S.watch}
              </Button>
            )}
            {note.kind === "candidate" && !accepted && note.instrument_id === null && (
              <span className="text-sm text-text-muted">{S.resolutionUnavailable}</span>
            )}
            {note.kind === "candidate" && accepted && onUndoAccept && (
              <Button disabled={busy} onPress={() => onUndoAccept(note.id)}>
                {S.undoWatch}
              </Button>
            )}
            {!note.dismissed && onDismiss && (
              <Button disabled={busy} onPress={() => onDismiss(note.id)}>
                {S.dismiss}
              </Button>
            )}
            {note.dismissed && onRestore && (
              <Button disabled={busy} onPress={() => onRestore(note.id)}>
                {S.restore}
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
