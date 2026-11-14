// The in-process side of the sync adapter (phone, tests) and of the test host (testing/host.ts):
// the open stores of this device and how a target, a query or a command is run against them.

import type { Command } from "@cashu/store";
import type { DeviceCommand, DeviceStore } from "@cashu/store/device";
import type { Query, QueryArgs, QuerySource } from "@cashu/store/query";
import {
  type CommandEnv,
  type CommandResult,
  type EventWriter,
  runCommand,
  type Store,
} from "@cashu/store/runtime";
import type { AnyCommand, Target } from "../client/types.js";

/** One vault open on this device whose commands append straight into its store (tests, fixtures). */
export interface VaultHandle {
  readonly store: Store;
  /** Where a command's events go (tests: `storeWriter(store)`). */
  readonly writer: EventWriter;
  /** This device's command env for the vault (one per device session). */
  readonly env: CommandEnv;
}

/**
 * One vault open on this device whose commands run through its sync engine (the phone): `execute` is
 * the durable command boundary (`executeDurableCommand` behind the vault's queue), `reconcile` answers
 * a key from the attempt journal after an `outcome_unknown`.
 */
export interface DurableVaultHandle {
  readonly store: Store;
  execute(command: Command<unknown, unknown>, input: unknown, key: string): Promise<DurableOutcome>;
  reconcile(key: string): Promise<DurableOutcome>;
}

/** A durable command's answer as the client sees it (`DurableCommandResult` without the eids). */
export type DurableOutcome =
  | { readonly kind: "completed"; readonly value: unknown }
  | { readonly kind: "refused" | "not_started"; readonly reason: string }
  | { readonly kind: "outcome_unknown"; readonly attemptId?: string };

/** The stores of this device. */
export interface LocalStores {
  readonly device: DeviceStore;
  readonly vaults: ReadonlyMap<string, VaultHandle | DurableVaultHandle>;
}

export function isDurable(handle: VaultHandle | DurableVaultHandle): handle is DurableVaultHandle {
  return "execute" in handle;
}

export class UnknownTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTargetError";
  }
}

function isDeviceCommand(command: AnyCommand): command is DeviceCommand<unknown, unknown> {
  return "scope" in command && command.scope === "device";
}

function vaultOf(stores: LocalStores, target: Target): VaultHandle | DurableVaultHandle {
  if (target.kind !== "vault") throw new UnknownTargetError("a vault target is required");
  const handle = stores.vaults.get(target.vault);
  if (handle === undefined) throw new UnknownTargetError("this vault is not open on this device");
  return handle;
}

/** The store `query` reads for `target` (its scope must match the target's kind). */
export function sourceFor(
  stores: LocalStores,
  target: Target,
  query: Query<QueryArgs, unknown>,
): QuerySource {
  if (query.scope !== target.kind) {
    throw new UnknownTargetError(`a ${query.scope} query cannot read the ${target.kind} store`);
  }
  return target.kind === "device" ? stores.device : vaultOf(stores, target).store;
}

/** Run `command` against `target`; the result without the appended events. */
export function runLocal(
  stores: LocalStores,
  target: Target,
  command: AnyCommand,
  input: unknown,
): CommandResult<unknown> {
  if (isDeviceCommand(command)) {
    if (target.kind !== "device") {
      throw new UnknownTargetError("a device command cannot write a vault");
    }
    return stores.device.run(command, input);
  }
  const vault = vaultOf(stores, target);
  if (isDurable(vault))
    throw new UnknownTargetError("a durable vault runs commands asynchronously");
  const outcome = runCommand(vault.store, vault.writer, command, input, vault.env);
  return outcome.ok ? { ok: true, value: outcome.value } : outcome;
}

/** The durable handle of `target` when its vault runs commands through an engine, else undefined. */
export function durableVault(
  stores: LocalStores,
  target: Target,
  command: AnyCommand,
): DurableVaultHandle | undefined {
  if (isDeviceCommand(command) || target.kind !== "vault") return undefined;
  const vault = vaultOf(stores, target);
  return isDurable(vault) ? vault : undefined;
}
