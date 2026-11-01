// What the host serves on the store channel: the queries and commands a `ui` session may use, by id.
// Anything not listed is refused (the renderer is sandboxed and not trusted). Same set as the S53 store
// process; screens add theirs here as they move onto the store (S55 series).
import { type Command, createProfile, renameProfile, setProfileSettings } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { currentVault, type DeviceCommand, setCurrentVault } from "@cashu/store/device";
import type { Query, QueryArgs } from "@cashu/store/query";

/** A vault command or a device command (its own `scope` says which store it writes). */
export type AnyCommand = Command<unknown, unknown> | DeviceCommand<unknown, unknown>;

export const SERVED_QUERIES: readonly Query<QueryArgs, unknown>[] = [currentVault, profile];

export const SERVED_COMMANDS: readonly AnyCommand[] = [
  setCurrentVault,
  createProfile,
  renameProfile,
  setProfileSettings,
] as readonly AnyCommand[];

export function isDeviceCommand(command: AnyCommand): command is DeviceCommand<unknown, unknown> {
  return "scope" in command && command.scope === "device";
}
