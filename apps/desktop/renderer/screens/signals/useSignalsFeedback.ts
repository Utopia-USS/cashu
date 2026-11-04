import { useEffect, useRef, useState } from "react";
import {
  type FailedOutcome,
  type GroupSaveOutcome,
  groupNotice,
  groupRefusal,
  guardedNotice,
  type SignalsNotice,
  thrownNotice,
} from "./outcomes.js";

/** What every Signals surface shows after an owner write: one notice, one refusal, the last undo. */
export interface SignalsFeedback {
  readonly busy: boolean;
  readonly notice: SignalsNotice | null;
  readonly refusal: string | null;
  readonly undoIds: readonly string[];
}

/**
 * One owner write at a time across the whole screen. `exclusive` runs a write unless another is in
 * flight, keeps `busy` for its duration and turns a throw into a logged "unknown" notice.
 */
export function useSignalsFeedback() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<SignalsNotice | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [undoIds, setUndoIds] = useState<readonly string[]>([]);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const isActive = () => active.current;
  async function exclusive<T>(
    scope: string,
    write: () => Promise<T>,
    options: { readonly clearRefusal?: boolean } = {},
  ): Promise<T | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    if (options.clearRefusal) setRefusal(null);
    try {
      return await write();
    } catch (error) {
      setNotice(thrownNotice(scope, error));
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const failed = (result: FailedOutcome) => {
    if (result.kind === "refused") setRefusal(result.reason);
    setNotice(guardedNotice(result));
  };
  const grouped = (outcome: GroupSaveOutcome) => {
    setUndoIds(outcome.decisions);
    setNotice(groupNotice(outcome));
    const reason = groupRefusal(outcome);
    if (reason !== null) setRefusal(reason);
  };
  const state: SignalsFeedback = { busy, notice, refusal, undoIds };
  return {
    state,
    exclusive,
    isActive,
    isBusy: () => inFlight.current,
    setNotice,
    setRefusal,
    setUndoIds,
    /** A guarded command that did not complete: its refusal (if any) and notice. */
    failed,
    /** A sequential group save: its decisions become the undo set. */
    grouped,
  };
}
export type SignalsFeedbackApi = ReturnType<typeof useSignalsFeedback>;
