// The one keyed host command boundary. Synthetic device/view commands retain their atomic SQLite
// request transaction. Native vault commands use a private may-append journal, then one encrypted
// engine append, then a durable completed receipt. The portable executor owns its queue acquisition;
// no caller may hold the same queue around a native run. The typed runHostVaultCommand is the
// preferred API for async host surfaces.

import { randomBytes } from "node:crypto";
import { decodeValue, encodeValue, type JsonValue } from "@cashu/host-protocol/store";
import {
  type Command,
  type CommandResult,
  type DurableCommandResult,
  type EventWriter,
  executeDurableCommand,
  mintUlid,
  runCommand,
} from "@cashu/store";
import type { DeviceCommand } from "@cashu/store/device";
import type { RunResult } from "./requests.js";
import type { OpenDevice, OpenVault, SyntheticOpenVault } from "./stores.js";

/** A key reused for another command: a client bug, refused loudly. */
class KeyReusedError extends Error {
  constructor() {
    super("this idempotency key was used for another command");
    this.name = "KeyReusedError";
  }
}

const crossing = (result: CommandResult<unknown>): RunResult =>
  result.ok ? { ok: true, value: encodeValue(result.value) } : { ok: false, reason: result.reason };

/** Answers from the table when the key is known (same command), else undefined. */
function stored(
  target: SyntheticOpenVault | OpenDevice,
  key: string,
  command: string,
): RunResult | undefined {
  const prior = target.requests.lookup(key);
  if (prior === undefined) return undefined;
  if (prior.command !== command) throw new KeyReusedError();
  return prior.result;
}

export interface KeyedRun {
  readonly result: RunResult | DurableCommandResult<JsonValue>;
  /** Synthetic request-table replay flag; native replay is represented by its durable result. */
  readonly replayed: boolean;
}

/** Low-level crossing form: synthetic caller holds queue, native caller does not. */
export function runVaultCommand(
  vault: OpenVault,
  command: Command<unknown, unknown>,
  input: unknown,
  key: string,
  current: () => boolean = () => true,
): KeyedRun | Promise<KeyedRun> {
  if (vault.native !== undefined) {
    const native = vault.native;
    const checked: Command<unknown, JsonValue> = {
      ...command,
      run(ctx, parsed) {
        const result = command.run(ctx, parsed);
        return result.ok ? { ok: true, value: encodeValue(result.value) } : result;
      },
    };
    return executeDurableCommand(
      {
        vault: vault.id,
        device: native.device,
        store: native.store,
        engine: native.engine,
        clock: vault.env.clock,
        lease: vault.env.lease,
        attempts: native.attempts,
        queue: {
          run(id, task) {
            if (id !== native.id) return Promise.reject(new Error("vault_mismatch"));
            return native.queue.run(task);
          },
        },
        isCurrent: () => native.canRunSideEffects() && vault.native === native && current(),
        newAttemptId: () => mintUlid(Date.now(), (n) => new Uint8Array(randomBytes(n))),
      },
      checked,
      input,
      key,
    ).then((result) => ({ result, replayed: false }));
  }
  return vault.driver.transaction(() => {
    const prior = stored(vault, key, command.id);
    if (prior !== undefined) return { result: prior, replayed: true };
    let decided: CommandResult<unknown> | undefined;
    let recorded = false;
    const capture: Command<unknown, unknown> = {
      ...command,
      run(ctx, parsed) {
        decided = command.run(ctx, parsed);
        return decided;
      },
    };
    const writer: EventWriter = {
      append(envelopes) {
        if (decided === undefined) throw new Error("events appended before the command decided");
        vault.requests.record(key, command.id, crossing(decided));
        recorded = true;
        vault.writer.append(envelopes);
      },
    };
    const outcome = runCommand(vault.store, writer, capture, input, vault.env);
    const result: RunResult = outcome.ok
      ? crossing({ ok: true, value: outcome.value })
      : { ok: false, reason: outcome.reason };
    if (!recorded) vault.requests.record(key, command.id, result);
    return { result, replayed: false };
  });
}

/** One public host command seam for async surfaces. It owns the only queue acquisition. */
export async function runHostVaultCommand<I, R>(
  vault: OpenVault,
  command: Command<I, R>,
  input: unknown,
  key: string,
  current: () => boolean = () => true,
): Promise<DurableCommandResult<R>> {
  try {
    if (!current()) return { kind: "not_started", reason: "session_unavailable" };
  } catch {
    return { kind: "not_started", reason: "session_unavailable" };
  }
  try {
    const task = (): KeyedRun | Promise<KeyedRun> =>
      current()
        ? runVaultCommand(vault, command as Command<unknown, unknown>, input, key, current)
        : { result: { kind: "not_started", reason: "session_unavailable" }, replayed: false };
    const keyed = vault.native === undefined ? await vault.queue.run(task) : await task();
    const result = keyed.result;
    if ("kind" in result) {
      return result.kind === "completed"
        ? { kind: "completed", value: decodeValue(result.value) as R, eids: result.eids }
        : result;
    }
    return result.ok
      ? { kind: "completed", value: decodeValue(result.value) as R, eids: [] }
      : { kind: "refused", reason: result.reason };
  } catch {
    // Once dispatch was attempted, an exception may follow an append or a durable receipt.
    return { kind: "outcome_unknown", key };
  }
}

/** Read-only phase for status surfaces, including a completed receipt whose value expired. */
export function lookupHostVaultCommandStatus(
  vault: OpenVault,
  commandId: string,
  key: string,
): "completed" | "refused" | "not_started" | "outcome_unknown" {
  try {
    if (vault.native !== undefined) {
      if (!vault.native.isCurrent()) return "outcome_unknown";
      const status = vault.native.attempts.status(vault.id, key, commandId);
      if (status.phase === "completed") return "completed";
      if (status.phase === "terminal") return status.result.kind;
      return "outcome_unknown";
    }
    const saved = vault.requests.lookup(key);
    if (saved === undefined) return "outcome_unknown";
    if (saved.command !== commandId) return "refused";
    return saved.result.ok ? "completed" : "refused";
  } catch {
    return "outcome_unknown";
  }
}

/** Runs a device command once per key. Call inside the device store's write queue. */
export function runDeviceCommand(
  device: OpenDevice,
  command: DeviceCommand<unknown, unknown>,
  input: unknown,
  key: string,
): KeyedRun {
  return device.driver.transaction(() => {
    const prior = stored(device, key, command.id);
    if (prior !== undefined) return { result: prior, replayed: true };
    const result = crossing(device.store.run(command, input));
    device.requests.record(key, command.id, result);
    return { result, replayed: false };
  });
}
