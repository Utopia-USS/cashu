import { lang } from "@cashu/i18n";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import { useCommand } from "@cashu/store-react";
import { useState } from "react";
import { commandFailure, type GuardedOutcome, useDurableCommands } from "../useDurableCommand.js";
import { S } from "./Research.strings.js";

const commands = researchScreenCommands();

/** Owner actions for the Home candidate rail; query updates provide the readback. */
export function useResearchCandidatesRail() {
  const dismiss = useCommand(commands.dismissNote);
  const accept = useCommand(commands.acceptCandidate);
  const durable = useDurableCommands();
  const [notice, setNotice] = useState<string | null>(null);
  const finish = async (work: Promise<GuardedOutcome<unknown>>) => {
    try {
      const result = await work;
      setNotice(result.kind === "completed" ? S.saved : commandFailure(result, S.refused));
    } catch {
      setNotice(S.unknown);
    }
  };
  return {
    notice,
    busy: dismiss.isPending || accept.isPending,
    dismiss: (note: string) =>
      finish(durable.run(`dismiss:${note}`, dismiss, { note, lang: lang() })),
    watch: (note: string, instrument: string | null) => {
      if (instrument === null) return setNotice(S.resolutionUnavailable);
      void finish(durable.run(`accept:${note}`, accept, { note, lang: lang() }));
    },
  };
}
