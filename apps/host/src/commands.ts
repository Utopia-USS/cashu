// Running one keyed command against one store, inside that store's write queue. The key lookup, the
// command's events and the key's record are one transaction:
//   1. a key already recorded answers with its stored result (nothing runs again);
//   2. otherwise the command runs; for a vault command the key row is written by the writer right
//      before the events are applied (same transaction), so the apply and its change notification
//      are the last writes before COMMIT; a command that emitted nothing records its key after it ran.
// The stored result is the crossing form (JSON value codec), encoded before the apply, so a value the
// codec refuses fails the command before anything is written.
import { encodeValue } from "@cashu/host-protocol/store";
import { type Command, type CommandResult, type EventWriter, runCommand } from "@cashu/store";
import type { DeviceCommand } from "@cashu/store/device";
import type { RunResult } from "./requests.js";
import type { OpenDevice, OpenVault } from "./stores.js";

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
  target: OpenVault | OpenDevice,
  key: string,
  command: string,
): RunResult | undefined {
  const prior = target.requests.lookup(key);
  if (prior === undefined) return undefined;
  if (prior.command !== command) throw new KeyReusedError();
  return prior.result;
}

export interface KeyedRun {
  readonly result: RunResult;
  /** True when the result came from the table (a resend), not from running the command. */
  readonly replayed: boolean;
}

/** Runs a vault command once per key. Call inside the vault's write queue. */
export function runVaultCommand(
  vault: OpenVault,
  command: Command<unknown, unknown>,
  input: unknown,
  key: string,
): KeyedRun {
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
