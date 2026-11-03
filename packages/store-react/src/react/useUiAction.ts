/** Async effects have explicit unknown delivery; they never inherit command replay. */
import type { UiAction, UiActionResult } from "@cashu/store/ui-actions";
import { useEffect, useRef, useTransition } from "react";
import { useStoreClient } from "./context.js";
import { useTarget } from "./useQuery.js";

export function useUiAction<I, R>(action: UiAction<I, R>) {
  const client = useStoreClient();
  const target = useTarget("vault");
  const vault = target.kind === "vault" ? target.vault : null;
  const consumers = useRef(new Set<(result: UiActionResult<R>) => void>());
  const active = useRef(true);
  const unresolved = useRef(new Set<string>());
  const invoking = useRef(new Set<string>());
  const scope = `${action.id}:${vault ?? "unselected"}`;
  useEffect(() => {
    active.current = true;
    const pending = consumers.current;
    const uncertain = unresolved.current;
    const activeInvocations = invoking.current;
    return () => {
      active.current = false;
      if (pending.size > 0) uncertain.add(scope);
      activeInvocations.delete(scope);
      for (const resolve of pending) resolve({ status: "outcome_unknown", reason: "interrupted" });
      pending.clear();
    };
  }, [client, vault, action.id, scope]);
  const [isPending, startTransition] = useTransition();
  const run = (input: I): Promise<UiActionResult<R>> =>
    new Promise((resolve) => {
      if (!active.current) {
        resolve({ status: "outcome_unknown", reason: "interrupted" });
        return;
      }
      if (unresolved.current.has(scope) || invoking.current.has(scope)) {
        resolve({ status: "not_started", reason: "pending_previous_attempt" });
        return;
      }
      invoking.current.add(scope);
      consumers.current.add(resolve);
      startTransition(async () => {
        let result: UiActionResult<R>;
        try {
          result =
            client.invoke === undefined
              ? { status: "not_started", reason: "capability_unavailable" }
              : await client.invoke(target, action, input);
        } catch {
          result = { status: "outcome_unknown", reason: "unexpected_failure" };
        }
        if (result.status === "outcome_unknown") unresolved.current.add(scope);
        invoking.current.delete(scope);
        if (consumers.current.delete(resolve)) resolve(result);
      });
    });
  return { run, isPending };
}
