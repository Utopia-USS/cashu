// The in-process side of the sync adapter (phone, tests) and of the test host (testing/host.ts):
// the open stores of this device and how a target, a query or a command is run against them.
import {
  type CommandEnv,
  type CommandResult,
  type EventWriter,
  runCommand,
  type Store,
} from "@cashu/store";
import type { DeviceCommand, DeviceStore } from "@cashu/store/device";
import type { Query, QueryArgs, QuerySource } from "@cashu/store/query";
import type { AnyCommand, Target } from "../client/types.js";

/** One vault open on this device: its store and how its commands append events. */
export interface VaultHandle {
  readonly store: Store;
  /** The sync engine's local append (tests: `storeWriter(store)`). */
  readonly writer: EventWriter;
  /** This device's command env for the vault (one per device session). */
  readonly env: CommandEnv;
}

/** The stores of this device. */
export interface LocalStores {
  readonly device: DeviceStore;
  readonly vaults: ReadonlyMap<string, VaultHandle>;
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

function vaultOf(stores: LocalStores, target: Target): VaultHandle {
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
  const outcome = runCommand(vault.store, vault.writer, command, input, vault.env);
  return outcome.ok ? { ok: true, value: outcome.value } : outcome;
}
