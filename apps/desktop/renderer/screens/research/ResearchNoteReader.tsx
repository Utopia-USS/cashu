import { lang } from "@cashu/i18n";
import {
  researchScreenCommands,
  researchScreenQueries,
} from "@cashu/store/investments/research-screen";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useState } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { researchNoteDates, researchNoteFacts } from "./presentation.js";
import { S } from "./Research.strings.js";
import { ResearchNoteView } from "./ResearchNoteView.js";

const queries = researchScreenQueries();
const commands = researchScreenCommands();
export function ResearchNoteReader({
  noteGid,
  onClose,
  onOpenAsset,
  onOpenTopic,
}: {
  noteGid: string;
  onClose(): void;
  onOpenAsset?(instrument: string, note: string): void;
  onOpenTopic?(key: string): void;
}) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <BoundNote
      key={`${vault}:${privacy}:${noteGid}`}
      noteGid={noteGid}
      onClose={onClose}
      onOpenAsset={onOpenAsset}
      onOpenTopic={onOpenTopic}
    />
  );
}
function BoundNote(props: Parameters<typeof ResearchNoteReader>[0]) {
  const { privacy } = useUiEnv();
  const today = useCalendarDay();
  const result = useQuery(queries.note, { today, lang: lang(), note: props.noteGid });
  const dismiss = useCommand(commands.dismissNote);
  const restore = useCommand(commands.restoreNote);
  const accept = useCommand(commands.acceptCandidate);
  const undo = useCommand(commands.undoAcceptCandidate);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (job: Promise<{ ok: boolean; reason?: string }>) => {
    try {
      const outcome = await job;
      setNotice(outcome.ok ? S.saved : `${S.refused}: ${outcome.reason ?? ""}`);
    } catch {
      setNotice(S.unknown);
    }
  };
  if (result.status !== "current" || !result.note)
    return (
      <section
        role="dialog"
        aria-modal="true"
        aria-label={S.details}
        className="fixed inset-0 z-50 grid place-items-center bg-overlay"
      >
        <div className="rounded-lg bg-surface-raised p-6">
          <p>{S.unavailable}</p>
          <button type="button" onClick={props.onClose}>
            {S.close}
          </button>
        </div>
      </section>
    );
  return (
    <>
      {notice && (
        <p role="status" className="fixed bottom-4 right-4 z-50 rounded-sm bg-surface-raised p-3">
          {notice}
        </p>
      )}
      <ResearchNoteView
        note={result.note}
        dates={researchNoteDates(result.note)}
        facts={researchNoteFacts(result.note)}
        privacy={privacy}
        onClose={props.onClose}
        onOpenAsset={props.onOpenAsset}
        onOpenTopic={props.onOpenTopic}
        onDismiss={(gid) => {
          void run(dismiss.run({ note: gid, lang: lang() }));
        }}
        onRestore={(gid) => {
          void run(restore.run({ note: gid, lang: lang() }));
        }}
        onAccept={(gid, instrument) => {
          if (!instrument) setNotice(S.resolutionUnavailable);
          else void run(accept.run({ note: gid, lang: lang() }));
        }}
        onUndoAccept={(gid) => {
          void run(undo.run({ note: gid }));
        }}
        busy={dismiss.isPending || restore.isPending || accept.isPending || undo.isPending}
      />
    </>
  );
}
