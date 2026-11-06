import { budget } from "@cashu/domain";
import {
  type ClassifierSettingsInput,
  classifierSettings,
  classifierSettingsState,
} from "@cashu/store/core/classifier-settings";
import { useProfile, useQuery, useUiAction } from "@cashu/store-react";
import { useLayoutEffect, useRef, useState } from "react";
import { T } from "./Classification.strings.js";

interface Draft {
  readonly vault: string;
  readonly key: string;
  /** The model typed for cloud classification; null follows the host's current setting. */
  readonly model: string | null;
  readonly accepted: boolean;
}
function initialDraft(vault: string): Draft {
  return { vault, key: "", model: null, accepted: false };
}

/** Settings > classification. The current settings are a live host query (checked by the host on its own and
 * again after every change, from any window); the panel only sends owner changes. */
export function useClassificationScreen() {
  const vault = useProfile();
  const live = useQuery(classifierSettingsState);
  const snapshot = live.status === "ready" ? live.snapshot : null;
  const action = useUiAction(classifierSettings);
  const run = useRef(action.run);
  const scope = useRef({ vault, generation: 0 });
  const pending = useRef<number | null>(null);
  const request = useRef(0);
  useLayoutEffect(() => {
    run.current = action.run;
    if (scope.current.vault !== vault) {
      scope.current = { vault, generation: scope.current.generation + 1 };
      request.current += 1;
      pending.current = null;
    }
  });
  const [state, setState] = useState({ vault, busy: false, notice: null as string | null });
  const [draft, setDraft] = useState(() => initialDraft(vault));
  const visible = state.vault === vault ? state : { vault, busy: false, notice: null };
  const visibleDraft = draft.vault === vault ? draft : initialDraft(vault);
  const edit = (change: Partial<Omit<Draft, "vault">>) =>
    setDraft((previous) => ({
      ...(previous.vault === vault ? previous : initialDraft(vault)),
      ...change,
    }));
  const model = visibleDraft.model ?? snapshot?.model ?? budget.ANTHROPIC_DEFAULT_MODEL;
  const current = (saved: typeof scope.current) =>
    scope.current.vault === saved.vault && scope.current.generation === saved.generation;
  const send = async (input: ClassifierSettingsInput) => {
    const saved = { ...scope.current };
    if (pending.current !== null || !snapshot) return;
    const ticket = ++request.current;
    pending.current = ticket;
    setState({ vault, busy: true, notice: null });
    try {
      const result = await run.current(input);
      if (!current(saved) || request.current !== ticket) return;
      setState({
        vault,
        busy: false,
        notice:
          result.status === "completed"
            ? null
            : result.status === "outcome_unknown"
              ? T.unknown
              : T.failed,
      });
      if (result.status === "completed")
        setDraft((previous) => ({
          ...(previous.vault === vault ? previous : initialDraft(vault)),
          key: "",
          accepted: false,
        }));
    } catch {
      if (current(saved) && request.current === ticket)
        setState({ vault, busy: false, notice: T.unknown });
    } finally {
      if (pending.current === ticket) pending.current = null;
    }
  };
  return {
    vault,
    snapshot,
    busy: visible.busy,
    notice: visible.notice ?? (live.status === "unavailable" ? T.unavailable : null),
    key: visibleDraft.key,
    setKey: (key: string) => edit({ key }),
    model,
    setModel: (next: string) => edit({ model: next }),
    accepted: visibleDraft.accepted,
    setAccepted: (accepted: boolean) => edit({ accepted }),
    chooseLocal: () => send({ op: "chooseLocal" }),
    grantCloud: () =>
      visibleDraft.accepted &&
      send({ op: "grantCloud", riskCopy: "merchant-name-residual-v1", model }),
    revokeCloud: () => send({ op: "revokeCloud" }),
    saveKey: () => visibleDraft.key && send({ op: "setKey", key: visibleDraft.key }),
    clearKey: () => send({ op: "clearKey" }),
  };
}
