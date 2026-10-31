// useCommand(command): `run(input)` validates and appends through the store (in-process on the phone,
// via the store process on the desktop) inside a React 19 transition, so `isPending` covers the round
// trip. Expected outcomes come back as the command's result union; an unexpected failure is thrown
// from the transition to the nearest error boundary (no error state to forget). No optimistic state:
// the local apply is the update, and the queries reading its tables re-run.
import type { CommandResult } from "@cashu/store";
import { useTransition } from "react";
import type { AnyCommand } from "../client/types.js";
import { useStoreClient } from "./context.js";
import { useTarget } from "./useQuery.js";

export interface CommandHandle<In, R> {
  /** Resolves with the result union; an unexpected failure goes to the error boundary instead. */
  run(input: In): Promise<CommandResult<R>>;
  readonly isPending: boolean;
}

export function useCommand<I, R, In>(command: AnyCommand<I, R, In>): CommandHandle<In, R> {
  const client = useStoreClient();
  const target = useTarget("scope" in command ? command.scope : "vault");
  const [isPending, startTransition] = useTransition();
  const run = (input: In): Promise<CommandResult<R>> =>
    new Promise((resolve) => {
      startTransition(async () => {
        resolve(await client.run(target, command, input));
      });
    });
  return { run, isPending };
}
