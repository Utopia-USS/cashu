// useCommand(command): `run(input)` validates and appends through the store (in-process on the phone,
// via the store process on the desktop) inside a React 19 transition. Every attempt settles with a
// durable outcome; an unclassified adapter rejection is unknown with the original attempt key.
// No optimistic state: the local apply updates queries reading touched tables. After an unknown outcome
// the next run reconciles that attempt before it writes anything (one run in flight per scope).
// `useCommand(command, { vault })` writes to that vault, never to the current profile: a sheet or modal
// pins the vault it was opened with, so a write can never follow a profile switch into another vault.
import { mintUlid } from "@cashu/store/gid";
import { use, useRef, useTransition } from "react";
import {
  type AnyCommand,
  type CommandAttempt,
  type CommandOutcome,
  DEVICE_TARGET,
  type Target,
} from "../client/types.js";
import { ProfileContext, StoreBindingError, useStoreClient } from "./context.js";

export interface CommandHandle<In, R> {
  run(input: In): Promise<CommandOutcome<R>>;
  reconcile(attempt: CommandAttempt): Promise<CommandOutcome<R>>;
  readonly isPending: boolean;
}

export interface CommandOptions {
  /**
   * The vault this handle writes to, instead of the current profile's. A run refuses with
   * `VAULT_UNAVAILABLE` (nothing written) when that vault is no longer open. Ignored for device commands.
   */
  readonly vault?: string;
}

/**
 * The run's input differs from the earlier attempt whose outcome was unknown, and that attempt turned out
 * to have completed: the earlier input is saved, this one was not run (the screen keeps it and says so).
 */
export const PREVIOUS_ATTEMPT_COMPLETED = "previous_attempt_completed";
/** The pinned vault (`CommandOptions.vault`) is not open on this device any more; nothing was written. */
export const VAULT_UNAVAILABLE = "vault_unavailable";

/** A comparable form of a run's input; null when it has none (then it never counts as the same input). */
function fingerprint(input: unknown): string | null {
  try {
    return JSON.stringify(input) ?? null;
  } catch {
    return null;
  }
}

export function useCommand<I, R, In>(
  command: AnyCommand<I, R, In>,
  options?: CommandOptions,
): CommandHandle<In, R> {
  const client = useStoreClient();
  const profile = use(ProfileContext);
  const pinned = options?.vault;
  const isDevice = "scope" in command && command.scope === "device";
  let target: Target;
  if (isDevice) target = DEVICE_TARGET;
  else {
    const vault = pinned ?? profile;
    if (vault === null) {
      throw new StoreBindingError(
        "a vault query or command needs a current profile (ProfileProvider)",
      );
    }
    target = { kind: "vault", vault };
  }
  const [isPending, startTransition] = useTransition();
  const scope =
    target.kind === "device" ? `device:${command.id}` : `vault:${target.vault}:${command.id}`;
  const uncertain = useRef(
    new Map<string, Extract<CommandOutcome<R>, { kind: "outcome_unknown" }>>(),
  );
  // The input of each attempt whose outcome is (or was) unknown, by attempt key.
  const inputs = useRef(new Map<string, string | null>());
  const active = useRef(new Map<string, Promise<CommandOutcome<R>>>());
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
  const dispatch = (input: In): Promise<CommandOutcome<R>> => {
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
    return new Promise<CommandOutcome<R>>((resolve) => {
      startTransition(async () => {
        try {
          const outcome = await client.run(target, command, input, attempt);
          if (outcome.kind === "outcome_unknown") {
            inputs.current.set(attempt.key, fingerprint(input));
            uncertain.current.set(scope, outcome);
          }
          resolve(outcome);
        } catch {
          const outcome = { kind: "outcome_unknown", key: attempt.key, attempt } as const;
          inputs.current.set(attempt.key, fingerprint(input));
          uncertain.current.set(scope, outcome);
          resolve(outcome);
        }
      });
    });
  };
  // After an `outcome_unknown` the next run first asks what became of that attempt. One that completed is
  // reported when this run carries the same input (the tap does not write a second time); with a changed
  // input the run answers `PREVIOUS_ATTEMPT_COMPLETED` (nothing written, the correction not dropped
  // silently). One that was refused or never started lets the new input run, and one still unknown keeps
  // the scope blocked until a later run learns more.
  const afterUnresolved = async (
    unresolved: Extract<CommandOutcome<R>, { kind: "outcome_unknown" }>,
    input: In,
  ): Promise<CommandOutcome<R>> => {
    const previous = await reconcile(unresolved.attempt);
    if (previous.kind === "completed") {
      const earlier = inputs.current.get(unresolved.attempt.key) ?? null;
      inputs.current.delete(unresolved.attempt.key);
      const now = fingerprint(input);
      // The same input: this tap's save is the earlier one. A different input (the owner corrected it
      // after "Could not save") is neither reported as saved nor written on top: the screen is told.
      if (earlier !== null && earlier === now) return previous;
      return { kind: "not_started", reason: PREVIOUS_ATTEMPT_COMPLETED };
    }
    if (previous.kind === "outcome_unknown")
      return { kind: "not_started", reason: "pending_previous_attempt" };
    inputs.current.delete(unresolved.attempt.key);
    return dispatch(input);
  };
  const run = (input: In): Promise<CommandOutcome<R>> => {
    if (pinned !== undefined && !isDevice && !client.vaults.includes(pinned))
      return Promise.resolve({ kind: "not_started", reason: VAULT_UNAVAILABLE });
    const running = active.current.get(scope);
    if (running !== undefined)
      return Promise.resolve({ kind: "not_started", reason: "pending_previous_attempt" });
    const unresolved = uncertain.current.get(scope);
    const pending = unresolved === undefined ? dispatch(input) : afterUnresolved(unresolved, input);
    active.current.set(scope, pending);
    void pending.then(() => {
      if (active.current.get(scope) === pending) active.current.delete(scope);
    });
    return pending;
  };
  return { run, reconcile, isPending };
}
