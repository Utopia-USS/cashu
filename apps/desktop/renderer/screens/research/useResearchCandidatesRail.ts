import { lang } from "@cashu/i18n";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import { useCommand } from "@cashu/store-react";
import { useState } from "react";
import { S } from "./Research.strings.js";

const commands = researchScreenCommands();

/** Owner actions for the Home candidate rail; query updates provide the readback. */
export function useResearchCandidatesRail() {
  const dismiss = useCommand(commands.dismissNote);
  const accept = useCommand(commands.acceptCandidate);
  const [notice, setNotice] = useState<string | null>(null);
  const finish = async (work: Promise<{ ok: boolean; reason?: string }>) => {
    try {
      const result = await work;
      setNotice(result.ok ? S.saved : `${S.refused}: ${result.reason ?? ""}`);
    } catch {
      setNotice(S.unknown);
    }
  };
  return {
    notice,
    busy: dismiss.isPending || accept.isPending,
    dismiss: (note: string) => finish(dismiss.run({ note, lang: lang() })),
    watch: (note: string, instrument: string | null) => {
      if (instrument === null) return setNotice(S.resolutionUnavailable);
      void finish(accept.run({ note, lang: lang() }));
    },
  };
}
