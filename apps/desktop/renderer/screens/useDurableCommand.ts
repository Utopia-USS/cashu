import { commandFingerprint } from "@cashu/store";
import type { CommandAttempt, CommandOutcome } from "@cashu/store-react";
import { useRef, useState } from "react";
import { O } from "./CommandOutcome.strings.js";

interface CommandHandle<In, R> {
  run(input: In): Promise<CommandOutcome<R>>;
  reconcile(attempt: CommandAttempt): Promise<CommandOutcome<R>>;
}

export type GuardedOutcome<R> =
  | CommandOutcome<R>
  | { kind: "previous_completed" | "previous_refused" };

interface PendingAttempt {
  readonly attempt: CommandAttempt;
  readonly fingerprint: string;
}

/** An uncertain form submission can only inspect its original key on a later click. */
export function useDurableCommands() {
  const attempts = useRef(new Map<string, PendingAttempt>());
  const pending = useRef(new Map<string, Promise<GuardedOutcome<unknown>>>());
  const [, changed] = useState(0);
  const [api] = useState(() => ({
    run: <In, R>(id: string, command: CommandHandle<In, R>, input: In) => {
      const active = pending.current.get(id);
      if (active)
        return Promise.resolve({
          kind: "not_started",
          reason: "pending_previous_attempt",
        } as const);
      // This is only a UI intent comparison. The host independently binds the real command fingerprint.
      const fingerprint = commandFingerprint("desktop-ui", id, input);
      const pendingAttempt = attempts.current.get(id);
      const task = (
        pendingAttempt ? command.reconcile(pendingAttempt.attempt) : command.run(input)
      ).then((result) => {
        if (result.kind === "outcome_unknown")
          attempts.current.set(id, {
            attempt: result.attempt,
            fingerprint: pendingAttempt?.fingerprint ?? fingerprint,
          });
        else attempts.current.delete(id);
        changed((value) => value + 1);
        if (pendingAttempt && fingerprint !== pendingAttempt.fingerprint) {
          if (result.kind === "completed") return { kind: "previous_completed" as const };
          if (result.kind === "refused") return { kind: "previous_refused" as const };
        }
        return result;
      });
      pending.current.set(id, task);
      void task.then(
        () => pending.current.delete(id),
        () => pending.current.delete(id),
      );
      return task;
    },
    uncertain: (id: string) => attempts.current.has(id),
    anyUncertain: () => attempts.current.size > 0,
  }));
  return api;
}

export function commandFailure(
  result: Exclude<GuardedOutcome<unknown>, { kind: "completed" }>,
  refused?: string,
): string {
  switch (result.kind) {
    case "refused":
      return refused ?? O.refused;
    case "not_started":
      return O.unavailable;
    case "outcome_unknown":
      return O.unknown;
    case "previous_completed":
      return O.previousCompleted;
    case "previous_refused":
      return O.previousRefused;
  }
}
