import { budget } from "@cashu/domain";
import {
  type ClassifierSettingsInput,
  type ClassifierSettingsSnapshot,
  classifierSettings,
  classifierSettingsSnapshotSchema,
} from "@cashu/store/core/classifier-settings";
import { useProfile, useUiAction } from "@cashu/store-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { T } from "./Classification.strings.js";

interface State {
  readonly vault: string;
  readonly snapshot: ClassifierSettingsSnapshot | null;
  readonly busy: boolean;
  readonly notice: string | null;
}
function initialDraft(vault: string) {
  return { vault, key: "", model: budget.ANTHROPIC_DEFAULT_MODEL, accepted: false };
}
function parsedSnapshot(result: { status: string; value?: unknown }) {
  if (result.status !== "completed") return null;
  const parsed = classifierSettingsSnapshotSchema.safeParse(result.value);
  return parsed.success ? parsed.data : null;
}

export function useClassificationScreen() {
  const vault = useProfile();
  const action = useUiAction(classifierSettings);
  const run = useRef(action.run);
  const scope = useRef({ vault, generation: 0 });
  const request = useRef(0);
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    run.current = action.run;
    if (scope.current.vault !== vault) {
      scope.current = { vault, generation: scope.current.generation + 1 };
      request.current += 1;
      pending.current = null;
    }
  });
  const [state, setState] = useState<State>({ vault, snapshot: null, busy: false, notice: null });
  const [draft, setDraft] = useState(() => initialDraft(vault));
  const visibleDraft = draft.vault === vault ? draft : initialDraft(vault);
  const setKey = (key: string) =>
    setDraft((previous) => ({
      ...(previous.vault === vault ? previous : initialDraft(vault)),
      key,
    }));
  const setModel = (model: string) =>
    setDraft((previous) => ({
      ...(previous.vault === vault ? previous : initialDraft(vault)),
      model,
    }));
  const setAccepted = (accepted: boolean) =>
    setDraft((previous) => ({
      ...(previous.vault === vault ? previous : initialDraft(vault)),
      accepted,
    }));
  const visible =
    state.vault === vault ? state : { vault, snapshot: null, busy: false, notice: null };
  const current = (saved: typeof scope.current) =>
    scope.current.vault === saved.vault && scope.current.generation === saved.generation;
  const refresh = async () => {
    const saved = { ...scope.current };
    if (pending.current !== null) return;
    const ticket = ++request.current;
    pending.current = ticket;
    setState({ vault, snapshot: visible.snapshot, busy: true, notice: null });
    try {
      const result = await run.current({ op: "status" });
      if (!current(saved) || request.current !== ticket) return;
      const snapshot = parsedSnapshot(result);
      setState({ vault, snapshot, busy: false, notice: snapshot ? null : T.unavailable });
      if (snapshot)
        setDraft((previous) => ({
          ...(previous.vault === vault ? previous : initialDraft(vault)),
          model: snapshot.model,
        }));
    } catch {
      if (current(saved) && request.current === ticket)
        setState({ vault, snapshot: null, busy: false, notice: T.unavailable });
    } finally {
      if (pending.current === ticket) pending.current = null;
    }
  };
  useEffect(() => {
    const saved = { ...scope.current };
    const ticket = ++request.current;
    pending.current = ticket;
    let active = true;
    void run
      .current({ op: "status" })
      .then((result) => {
        if (
          !active ||
          request.current !== ticket ||
          scope.current.vault !== saved.vault ||
          scope.current.generation !== saved.generation
        )
          return;
        const snapshot = parsedSnapshot(result);
        setState({ vault, snapshot, busy: false, notice: snapshot ? null : T.unavailable });
        if (snapshot)
          setDraft((previous) => ({
            ...(previous.vault === vault ? previous : initialDraft(vault)),
            model: snapshot.model,
          }));
      })
      .catch(() => {
        if (
          active &&
          request.current === ticket &&
          scope.current.vault === saved.vault &&
          scope.current.generation === saved.generation
        )
          setState({ vault, snapshot: null, busy: false, notice: T.unavailable });
      })
      .finally(() => {
        if (pending.current === ticket) pending.current = null;
      });
    return () => {
      active = false;
      if (pending.current === ticket) pending.current = null;
      if (request.current === ticket) request.current += 1;
    };
  }, [vault]);
  const send = async (input: ClassifierSettingsInput) => {
    const saved = { ...scope.current };
    if (pending.current !== null || !visible.snapshot) return;
    const ticket = ++request.current;
    pending.current = ticket;
    setState({ vault, snapshot: visible.snapshot, busy: true, notice: null });
    try {
      const result = await run.current(input);
      if (!current(saved) || request.current !== ticket) return;
      const parsed = parsedSnapshot(result);
      const snapshot = parsed ?? visible.snapshot;
      setState({
        vault,
        snapshot,
        busy: false,
        notice:
          result.status === "completed" && parsed
            ? null
            : result.status === "outcome_unknown"
              ? T.unknown
              : T.failed,
      });
      if (result.status === "completed" && parsed) {
        setDraft((previous) => ({
          ...(previous.vault === vault ? previous : initialDraft(vault)),
          key: "",
          accepted: false,
        }));
      }
    } catch {
      if (current(saved) && request.current === ticket)
        setState({ vault, snapshot: visible.snapshot, busy: false, notice: T.unknown });
    } finally {
      if (pending.current === ticket) pending.current = null;
    }
  };
  return {
    ...visible,
    key: visibleDraft.key,
    setKey,
    model: visibleDraft.model,
    setModel,
    accepted: visibleDraft.accepted,
    setAccepted,
    refresh,
    chooseLocal: () => send({ op: "chooseLocal" }),
    grantCloud: () =>
      visibleDraft.accepted &&
      send({ op: "grantCloud", riskCopy: "merchant-name-residual-v1", model: visibleDraft.model }),
    revokeCloud: () => send({ op: "revokeCloud" }),
    saveKey: () => visibleDraft.key && send({ op: "setKey", key: visibleDraft.key }),
    clearKey: () => send({ op: "clearKey" }),
  };
}
