// The research note actions with their toasts (ab24ab6 research/data.ts useResearchActions): dismiss (undo =
// restore), restore, `Obserwuj` (undo = the accept's undo), over the Home's native commands. The live queries
// carry the readback.
import { C } from "@cashu/i18n/core/common.strings";
import { S as U } from "@cashu/i18n/investments/undo.strings";
import { S } from "@cashu/i18n/investments/v2/research/data.strings";
import { useToast } from "@cashu/ui";
import { noteSubject } from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import { useResearchNoteActions } from "../investments/home/useInvestmentsHomeData.js";

export function useResearchActions() {
  const toast = useToast();
  const a = useResearchNoteActions();
  const offer = (text: string, what: string, run: () => Promise<string | null>) => {
    const retry = () => {
      void run().then((failed) => {
        if (failed) toast(U.failed(what), 8000, { label: C.undo, onClick: retry });
        else toast(U.done(what), 3000);
      });
    };
    toast(text, 10000, { label: C.undo, onClick: retry });
  };
  return {
    busy: a.busy,
    dismiss: async (n: ResearchNote) => {
      const failed = await a.dismiss(n);
      if (failed) return void toast(S.notDismissed(failed), 5000);
      const cand = n.kind === "candidate";
      offer(
        cand ? S.candidateDismissed(noteSubject(n).name) : S.noteDismissed,
        cand ? S.whatCandidateDismiss : S.whatNoteDismiss,
        () => a.restore(n),
      );
    },
    restore: async (n: ResearchNote) => {
      const failed = await a.restore(n);
      toast(
        failed
          ? S.notRestored(failed)
          : n.kind === "candidate"
            ? S.candidateRestored
            : S.noteRestored,
        failed ? 5000 : 2500,
      );
    },
    watch: async (n: ResearchNote) => {
      const failed = await a.watch(n);
      if (failed) return void toast(S.notWatched(failed), 5000);
      offer(S.watched(noteSubject(n).name), S.whatWatch, () => a.unwatch(n));
    },
  };
}
