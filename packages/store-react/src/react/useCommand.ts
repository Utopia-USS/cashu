// useCommand(command): `run(input)` validates and appends through the store (in-process on the phone,
// via the store process on the desktop) inside a React 19 transition. Every attempt settles with a
// durable outcome; an unclassified adapter rejection is unknown with the original attempt key.
// No optimistic state: the local apply updates queries reading touched tables.
import { mintUlid } from "@cashu/store/gid";
import { useRef, useTransition } from "react";
import type { AnyCommand, CommandAttempt, CommandOutcome } from "../client/types.js";
import { useStoreClient } from "./context.js";
import { useTarget } from "./useQuery.js";

export interface CommandHandle<In, R> {
  run(input: In): Promise<CommandOutcome<R>>;
  reconcile(attempt: CommandAttempt): Promise<CommandOutcome<R>>;
  readonly isPending: boolean;
}

export function useCommand<I, R, In>(command: AnyCommand<I, R, In>): CommandHandle<In, R> {
  const client = useStoreClient();
  const target = useTarget("scope" in command ? command.scope : "vault");
  const [isPending, startTransition] = useTransition();
  const scope =
    target.kind === "device" ? `device:${command.id}` : `vault:${target.vault}:${command.id}`;
  const uncertain = useRef(
    new Map<string, Extract<CommandOutcome<R>, { kind: "outcome_unknown" }>>(),
  );
  const active = useRef(new Map<string, Promise<CommandOutcome<R>>>());
  const run = (input: In): Promise<CommandOutcome<R>> => {
    const unresolved = uncertain.current.get(scope);
    if (unresolved !== undefined)
      return Promise.resolve({ kind: "not_started", reason: "pending_previous_attempt" });
    const running = active.current.get(scope);
    if (running !== undefined)
      return Promise.resolve({ kind: "not_started", reason: "pending_previous_attempt" });
    let attempt: CommandAttempt;
    try {
      attempt = Object.freeze({
        key: mintUlid(Date.now()),
        target: Object.freeze({ ...target }),
        command: command.id,
      });
    } catch {
      return Promise.resolve({ kind: "not_started", reason: "key_unavailable" });
    }
    const pending = new Promise<CommandOutcome<R>>((resolve) => {
      startTransition(async () => {
        try {
          const outcome = await client.run(target, command, input, attempt);
          if (outcome.kind === "outcome_unknown") uncertain.current.set(scope, outcome);
          resolve(outcome);
        } catch {
          const outcome = { kind: "outcome_unknown", key: attempt.key, attempt } as const;
          uncertain.current.set(scope, outcome);
          resolve(outcome);
        }
      });
    });
    active.current.set(scope, pending);
    void pending.then(() => {
      if (active.current.get(scope) === pending) active.current.delete(scope);
    });
    return pending;
  };
  const reconcile = (attempt: CommandAttempt): Promise<CommandOutcome<R>> =>
    (async () => {
      if (
        attempt.command !== command.id ||
        attempt.target.kind !== target.kind ||
        (attempt.target.kind === "vault" &&
          target.kind === "vault" &&
          attempt.target.vault !== target.vault)
      )
        return { kind: "outcome_unknown", key: attempt.key, attempt } as const;
      try {
        const outcome = await client.reconcile<R>(attempt);
        if (outcome.kind === "outcome_unknown") uncertain.current.set(scope, outcome);
        else if (uncertain.current.get(scope)?.key === attempt.key) uncertain.current.delete(scope);
        return outcome;
      } catch {
        return { kind: "outcome_unknown", key: attempt.key, attempt } as const;
      }
    })();
  return { run, reconcile, isPending };
}
