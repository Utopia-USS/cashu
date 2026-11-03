/** Narrow async UI effects: awaited capabilities, bounded fresh reads, then keyed allowed commands. */

import { decodeValue, encodeValue, idempotencyKeySchema } from "@cashu/host-protocol/store";
import { type Command, commandFingerprint, type DurableCommandResult, refuse } from "@cashu/store";
import { enabledModuleIds } from "@cashu/store/core";
import type { Read } from "@cashu/store/query";
import type { UiActionResult } from "@cashu/store/ui-actions";
import type { z } from "zod";
import { runHostVaultCommand } from "./commands.js";
import type { HostStores } from "./stores.js";

export interface UiActionBinding<C> {
  readonly generation: string;
  readonly capabilities: C;
  isCurrent(): boolean;
}

export interface PreparedUiCommand {
  readonly command: string;
  readonly input: unknown;
  readonly key: string;
}

export function unknownUiCommand(
  result: Extract<DurableCommandResult<unknown>, { kind: "outcome_unknown" }>,
  command: string,
): UiActionResult<never> {
  return {
    status: "outcome_unknown",
    reason: "interrupted",
    attempt: { key: result.key, command },
  };
}

export interface UiActionContext<C> {
  readonly vault: string;
  readonly generation: string;
  readonly capabilities: C;
  isCurrent(): boolean;
  /** Read expires before this callback returns to async code. Thenables are refused. */
  readStep<T>(read: (read: Read) => T): Promise<T>;
  /** Host registration owns command implementation; renderer never supplies executable objects. */
  execute(prepared: PreparedUiCommand): Promise<DurableCommandResult<unknown>>;
}

export interface UiActionRegistration {
  readonly id: string;
  run(
    stores: HostStores,
    vault: string,
    input: unknown,
    sessionCurrent?: () => boolean,
  ): Promise<UiActionResult<unknown>>;
}

function thenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function defineUiAction<I, C, R>(definition: {
  readonly id: string;
  readonly input: z.ZodType<I>;
  readonly module: string;
  readonly commands?: readonly Command<unknown, unknown>[];
  /** Synchronous optimistic digest/revision check, before any append; never receives a writer. */
  beforeExecute?(read: Read, prepared: PreparedUiCommand): boolean;
  bind(vault: string): UiActionBinding<C> | null;
  run(context: UiActionContext<C>, input: I): Promise<UiActionResult<R>>;
}): UiActionRegistration {
  const unresolved = new Map<string, { fingerprint: string; result: UiActionResult<R> }>();
  const running = new Set<string>();
  const serialized = (definition.commands?.length ?? 0) > 0;
  return {
    id: definition.id,
    async run(stores, id, raw, sessionCurrent = () => true) {
      const input = definition.input.safeParse(raw);
      if (!input.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const fingerprint = commandFingerprint(id, definition.id, input.data);
      const prior = unresolved.get(id);
      if (prior !== undefined)
        return prior.fingerprint === fingerprint
          ? prior.result
          : { status: "not_started", reason: "pending_previous_attempt" };
      if (serialized && running.has(id))
        return { status: "not_started", reason: "pending_previous_attempt" };
      if (serialized) running.add(id);
      let lastAttempt: { readonly key: string; readonly command: string } | undefined;
      try {
        const vault = stores.vaults.get(id);
        if (vault === undefined)
          return { status: "refused", reason: "unknown_target", preparation: "none" };
        if (!enabledModuleIds(vault.store.read.bind(vault.store)).has(definition.module))
          return { status: "refused", reason: "module_disabled", preparation: "none" };
        const binding = definition.bind(id);
        if (binding === null)
          return { status: "refused", reason: "capability_unavailable", preparation: "none" };
        const isCurrent = () =>
          sessionCurrent() &&
          stores.vaults.get(id) === vault &&
          binding.isCurrent() &&
          enabledModuleIds(vault.store.read.bind(vault.store)).has(definition.module);
        const guard = () => {
          if (!isCurrent()) throw new Error("stale_action");
        };
        const commands = new Map(definition.commands?.map((command) => [command.id, command]));
        const context: UiActionContext<C> = {
          vault: id,
          generation: binding.generation,
          capabilities: binding.capabilities,
          isCurrent,
          readStep(work) {
            return vault.queue.run(() => {
              guard();
              let active = true;
              const read: Read = (sql, ...params) => {
                if (!active) throw new Error("expired_action_read");
                guard();
                return vault.store.read(sql, ...params);
              };
              try {
                const result = work(read);
                if (thenable(result)) {
                  void Promise.resolve(result).catch(() => {});
                  throw new Error("async_action_read");
                }
                return result;
              } finally {
                active = false;
              }
            });
          },
          execute(prepared) {
            // Freeze the intent before queueing; schema parsing remains the real command boundary.
            const commandId = prepared.command;
            const command = commands.get(commandId);
            if (command === undefined)
              return Promise.resolve({ kind: "refused", reason: "unknown_command" });
            const commandInput = decodeValue(encodeValue(prepared.input));
            const key = idempotencyKeySchema.parse(prepared.key);
            const beforeExecute = definition.beforeExecute;
            const checked: Command<unknown, unknown> = beforeExecute
              ? {
                  ...command,
                  run(ctx, parsed) {
                    if (!isCurrent()) return refuse("stale_action");
                    let active = true;
                    const read: Read = (sql, ...params) => {
                      if (!active) throw new Error("expired_action_read");
                      return ctx.read(sql, ...params);
                    };
                    let allowed: boolean;
                    try {
                      allowed = beforeExecute(read, {
                        command: commandId,
                        input: commandInput,
                        key,
                      });
                    } finally {
                      active = false;
                    }
                    if (thenable(allowed)) {
                      void Promise.resolve(allowed).catch(() => {});
                      return refuse("stale_preparation");
                    }
                    return allowed === true
                      ? command.run(ctx, parsed)
                      : refuse("stale_preparation");
                  },
                }
              : command;
            lastAttempt = { key, command: commandId };
            return runHostVaultCommand(vault, checked, commandInput, key, isCurrent);
          },
        };
        guard();
        const result = await definition.run(context, input.data);
        if (result.status === "outcome_unknown") unresolved.set(id, { fingerprint, result });
        return result;
      } catch (error) {
        if (lastAttempt !== undefined) {
          const result: UiActionResult<R> = {
            status: "outcome_unknown",
            reason: "interrupted",
            attempt: lastAttempt,
          };
          unresolved.set(id, { fingerprint, result });
          return result;
        }
        throw error;
      } finally {
        if (serialized) running.delete(id);
      }
    },
  };
}
